param([ValidateSet('image','pdf')][string]$Mode = 'image', [string]$Pages = '', [int]$PageCount = 0)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime]

$script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await-Result($operation, [Type]$resultType) {
    $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}
function Await-Action($operation) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    $task = $method.Invoke($null, @($operation))
    $null = $task.GetAwaiter().GetResult()
}
function Read-Bitmap($stream) {
    $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ($decoder.PixelWidth -gt 10000 -or $decoder.PixelHeight -gt 10000 -or ([long]$decoder.PixelWidth * $decoder.PixelHeight) -gt 25000000) { throw 'OCR_LIMIT' }
    $size = [Math]::Min(4096, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
    $scale = [Math]::Min(1, $size / [double][Math]::Max($decoder.PixelWidth, $decoder.PixelHeight))
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelWidth * $scale))
    $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelHeight * $scale))
    $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    return @{ bitmap=$bitmap; width=[int]$decoder.OrientedPixelWidth; height=[int]$decoder.OrientedPixelHeight; scaled=($scale -lt 1) }
}
function Read-Lines($bitmap) {
    $result = Await-Result ($script:engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
        if ([string]::IsNullOrWhiteSpace($line.Text)) { continue }
        $left = [double]$bitmap.PixelWidth; $top = [double]$bitmap.PixelHeight; $right = 0.0; $bottom = 0.0
        foreach ($word in $line.Words) {
            $box = $word.BoundingRect
            $left=[Math]::Min($left,$box.X); $top=[Math]::Min($top,$box.Y)
            $right=[Math]::Max($right,$box.X+$box.Width); $bottom=[Math]::Max($bottom,$box.Y+$box.Height)
        }
        # WinRT does not expose confidence. 0 means unknown, never a fabricated high score.
        $lines += @{ text=($line.Text -replace '(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])',''); confidence=0; box=@{ x=$left/$bitmap.PixelWidth;
            y=$top/$bitmap.PixelHeight; width=($right-$left)/$bitmap.PixelWidth; height=($bottom-$top)/$bitmap.PixelHeight } }
    }
    return ,$lines
}
$prefix = if ($Mode -eq 'pdf') { 'PDF_OCR_' } else { 'OCR_' }
$stream=$null; $writer=$null
try {
    $script:engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $script:engine) { throw ($prefix+'LANGUAGE') }
    $inputStream = [Console]::OpenStandardInput()
    $memory = New-Object System.IO.MemoryStream
    $chunk = New-Object byte[] 65536
    while (($read = $inputStream.Read($chunk,0,$chunk.Length)) -gt 0) {
        if (($memory.Length+$read) -gt 10000000) { throw ($prefix+'LIMIT') }
        $memory.Write($chunk,0,$read)
    }
    $bytes = $memory.ToArray(); $memory.Dispose()
    if ($bytes.Length -eq 0) { throw ($prefix+'INVALID') }
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
    $writer.WriteBytes($bytes)
    $null = Await-Result ($writer.StoreAsync()) ([uint32])
    $null = $writer.DetachStream(); $writer.Dispose(); $writer=$null; $stream.Seek(0)
    if ($Mode -eq 'image') {
        $item = Read-Bitmap $stream
        try { $lines = Read-Lines $item.bitmap } finally { $item.bitmap.Dispose() }
        $format = if ($bytes[0] -eq 137) { 'png' } else { 'jpeg' }
        $output = @{version=1; engine='windows-ocr'; format=$format; width=$item.width; height=$item.height; scaled=$item.scaled; lines=@($lines)}
    } else {
        $pdf = Await-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromStreamAsync($stream)) ([Windows.Data.Pdf.PdfDocument])
        if ($pdf.PageCount -ne $PageCount -or $PageCount -gt 250) { throw 'PDF_OCR_LIMIT' }
        $requested = @($Pages.Split(',') | ForEach-Object { [int]$_ })
        if ($requested.Count -gt 20 -or $requested.Count -lt 1 -or @($requested | Select-Object -Unique).Count -ne $requested.Count) { throw 'PDF_OCR_LIMIT' }
        $rows=@(); $totalPixels=0
        foreach ($number in $requested) {
            if ($number -lt 1 -or $number -gt $PageCount) { throw 'PDF_OCR_LIMIT' }
            $page=$pdf.GetPage([uint32]($number-1)); $render=$null
            try {
                $w=[double]$page.Size.Width; $h=[double]$page.Size.Height
                if ($w -le 0 -or $h -le 0 -or $w -gt 10000 -or $h -gt 10000) { throw 'PDF_OCR_LIMIT' }
                $scale=[Math]::Min(2.0, 3000/[Math]::Max($w,$h))
                $options=New-Object Windows.Data.Pdf.PdfPageRenderOptions
                $options.DestinationWidth=[uint32][Math]::Max(1,[Math]::Floor($w*$scale))
                $options.DestinationHeight=[uint32][Math]::Max(1,[Math]::Floor($h*$scale))
                $totalPixels += [long]$options.DestinationWidth*$options.DestinationHeight
                if ($totalPixels -gt 100000000) { throw 'PDF_OCR_LIMIT' }
                $render=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
                Await-Action ($page.RenderToStreamAsync($render,$options)); $render.Seek(0)
                $item=Read-Bitmap $render
                try { $lines=Read-Lines $item.bitmap } finally { $item.bitmap.Dispose() }
                $rows += @{page=$number; width=$item.width; height=$item.height; pageWidthPoints=($w*0.75); pageHeightPoints=($h*0.75); scaled=($scale -lt 2); lines=@($lines)}
            } finally { if ($render) { $render.Dispose() }; $page.Dispose() }
        }
        $output=@{version=1; engine='windows-ocr-pdf'; pageCount=$PageCount; pages=@($rows)}
    }
    [Console]::WriteLine(($output | ConvertTo-Json -Depth 12 -Compress))
} catch {
    $code=$_.Exception.Message
    if ($code -notmatch '^(PDF_)?OCR_(LIMIT|LANGUAGE|INVALID)$') { $code=$prefix+'FAILED' }
    [Console]::WriteLine((@{error=$code} | ConvertTo-Json -Compress))
    exit 1
} finally { if ($writer) { $writer.Dispose() }; if ($stream) { $stream.Dispose() } }
