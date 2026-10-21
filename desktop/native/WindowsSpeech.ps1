param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $text = [IO.File]::ReadAllText($InputFile,[Text.Encoding]::UTF8)
    if ($text.Length -gt 5000 -or [string]::IsNullOrWhiteSpace($text)) { throw 'Speech text must contain 1-5000 characters' }
    if ($text -match '[\u4e00-\u9fff]') {
        $voice = $speech.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
        if (-not $voice) { throw 'No Chinese speech voice is installed in Windows' }
        $speech.SelectVoice($voice.VoiceInfo.Name)
    }
    $speech.SetOutputToWaveFile($OutputFile)
    $speech.Speak($text)
} finally { $speech.Dispose() }
