using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;
using System.IO;
using System.Threading;

static class WindowsCapture {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    [STAThread] static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { SetProcessDPIAware(); }
        Application.EnableVisualStyles();
        try {
            if (args.Length == 2 && args[0] == "--screenshot") {
                using (var picker = new RegionPicker(args[1])) Application.Run(picker);
                return 0;
            }
            if (args.Length == 2 && args[0] == "--selection") { WatchSelection(int.Parse(args[1])); return 0; }
            if (args.Length == 1 && args[0] == "--copy-selection") { CopySelection(); return 0; }
            return 2;
        } catch { Emit(new { type="error", message="Windows 捕获组件无法完成操作，请重试或手动复制粘贴。" }); return 1; }
    }
    static void WatchSelection(int ownerPid) {
        var timer = new System.Windows.Forms.Timer { Interval=100 };
        bool wasSelecting=false; int delay=0; string last=""; IntPtr previous=IntPtr.Zero;
        Emit(new { type="status", trusted=true });
        timer.Tick += delegate {
            try { if (Process.GetProcessById(ownerPid).HasExited) { Application.Exit(); return; } }
            catch { Application.Exit(); return; }
            var window=GetForegroundWindow();
            if (window != previous) { previous=window; last=""; Emit(new {type="dismiss", reason="app_changed"}); }
            bool selecting=GetAsyncKeyState(1)<0 || (GetAsyncKeyState(17)<0&&GetAsyncKeyState(65)<0) || (GetAsyncKeyState(16)<0 &&
                (GetAsyncKeyState(37)<0 || GetAsyncKeyState(38)<0 || GetAsyncKeyState(39)<0 || GetAsyncKeyState(40)<0 || GetAsyncKeyState(35)<0 || GetAsyncKeyState(36)<0));
            if (wasSelecting && !selecting) { delay=2; Emit(new {type="diagnostic", stage="gesture_received"}); }
            wasSelecting=selecting;
            if (selecting || delay==0 || --delay>0) return;
            try {
                uint pid; GetWindowThreadProcessId(window, out pid);
                if (pid == ownerPid || pid == Process.GetCurrentProcess().Id) { Emit(new {type="diagnostic", stage="own_app"}); return; }
                var element=AutomationElement.FocusedElement;
                if (element==null || element.Current.IsPassword || element.Current.ProcessId != (int)pid) return;
                object pattern;
                var title=new StringBuilder(501); GetWindowText(window,title,title.Capacity);
                string name=Process.GetProcessById((int)pid).ProcessName;
                if (!element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
                    Emit(new {type="diagnostic", stage="selection_unavailable"});
                    var type=element.Current.ControlType;
                    if(type==ControlType.Edit||type==ControlType.Document||type==ControlType.Text)
                        Emit(new {type="candidate",app=name,bundleId=name,windowTitle=title.ToString(),pid=pid,windowHandle=window.ToInt64()});
                    return;
                }
                Emit(new {type="diagnostic", stage="read_started"});
                var ranges=((TextPattern)pattern).GetSelection(); var text=new StringBuilder();
                foreach (var range in ranges) { text.Append(range.GetText(20001)); if(text.Length>20000) return; }
                string value=text.ToString().Trim();
                if (value.Length<2) { last=""; Emit(new {type="dismiss", reason="selection_cleared"}); return; }
                if (value==last || GetForegroundWindow()!=window) return;
                last=value;
                Emit(new {type="selection", text=value, app=name, bundleId=name, windowTitle=title.ToString(), pid=pid});
            } catch { Emit(new {type="diagnostic", stage="selection_unavailable"}); }
        };
        timer.Start(); Application.Run(); timer.Dispose();
    }
    static void CopySelection() {
        uint copied=0;DataObject saved=null;bool restore=false;string result=null,error=null;
        try {
            var raw=Console.ReadLine();if(raw==null||raw.Length>8192)throw new IOException();
            var request=Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(raw);
            int pid=Convert.ToInt32(request["pid"]);string name=(string)request["bundleId"],title=(string)request["windowTitle"];
            using(var process=Process.GetProcessById(pid)) {
                var window=request.ContainsKey("windowHandle")?new IntPtr(Convert.ToInt64(request["windowHandle"])):process.MainWindowHandle;
                uint owner;GetWindowThreadProcessId(window,out owner);var actualTitle=new StringBuilder(501);GetWindowText(window,actualTitle,actualTitle.Capacity);
                if(process.ProcessName!=name||actualTitle.ToString()!=title||window==IntPtr.Zero||owner!=pid)throw new IOException();
                SetForegroundWindow(window);Thread.Sleep(150);
                if(GetForegroundWindow()!=window)throw new IOException();
                var focused=AutomationElement.FocusedElement;
                if(focused==null||focused.Current.IsPassword||focused.Current.ProcessId!=pid)throw new IOException();
                // Materialize every format first. If preservation fails, do not copy.
                saved=new DataObject();var current=Clipboard.GetDataObject();
                if(current!=null) {
                    var formats=current.GetFormats(false);if(formats.Length>64)throw new IOException();
                    foreach(var format in formats) {
                        var value=current.GetData(format,false);if(value==null)throw new IOException();
                        var bitmap=value as Image;if(bitmap!=null)value=bitmap.Clone();
                        var stream=value as MemoryStream;if(stream!=null){if(stream.Length>32000000)throw new IOException();value=new MemoryStream(stream.ToArray());}
                        saved.SetData(format,false,value);
                    }
                }
                var before=GetClipboardSequenceNumber();
                if(GetAsyncKeyState(16)<0||GetAsyncKeyState(17)<0||GetAsyncKeyState(18)<0)throw new IOException();
                keybd_event(17,0,0,UIntPtr.Zero);keybd_event(67,0,0,UIntPtr.Zero);
                keybd_event(67,0,2,UIntPtr.Zero);keybd_event(17,0,2,UIntPtr.Zero);
                var deadline=DateTime.UtcNow.AddMilliseconds(1800);
                while(GetClipboardSequenceNumber()==before&&DateTime.UtcNow<deadline)Thread.Sleep(20);
                copied=GetClipboardSequenceNumber();if(copied==before)throw new IOException();
                restore=true;
                if(GetForegroundWindow()!=window)throw new IOException();
                string text=Clipboard.ContainsText()?Clipboard.GetText():null;
                if(string.IsNullOrWhiteSpace(text)||text.Trim().Length<2||text.Length>20000)throw new IOException();
                result=text.Trim();
            }
        } catch {error="未读取到选区，请重新选择；也可手动复制后粘贴到小窗。";}
        finally {
            // Do not replace newer clipboard content placed by the user or another app.
            if(restore&&saved!=null&&GetClipboardSequenceNumber()==copied)try{Clipboard.SetDataObject(saved,true);}catch{error="选区已读取，但原剪贴板未能恢复。";result=null;}
        }
        // Emit only after restoration: the caller may end this process on receipt.
        if(error!=null)Emit(new {type="copy_result",error=error});else Emit(new {type="copy_result",text=result});
    }
    sealed class RegionPicker : Form {
        readonly string output; readonly Bitmap snapshot; readonly Rectangle desktop;
        Point origin; Rectangle selection; bool dragging;
        public RegionPicker(string file) {
            output=file; desktop=SystemInformation.VirtualScreen;
            if ((long)desktop.Width*desktop.Height>100000000) throw new InvalidOperationException();
            snapshot=new Bitmap(desktop.Width,desktop.Height,PixelFormat.Format32bppArgb);
            using(var g=Graphics.FromImage(snapshot)) g.CopyFromScreen(desktop.Location,Point.Empty,desktop.Size);
            FormBorderStyle=FormBorderStyle.None; StartPosition=FormStartPosition.Manual; Bounds=desktop;
            TopMost=true; ShowInTaskbar=false; DoubleBuffered=true; KeyPreview=true; Cursor=Cursors.Cross;
            KeyDown += delegate(object sender,KeyEventArgs e) { if(e.KeyCode==Keys.Escape) Close(); };
            MouseDown += delegate(object sender,MouseEventArgs e) { if(e.Button==MouseButtons.Right) {Close();return;} origin=e.Location;dragging=true; };
            MouseMove += delegate(object sender,MouseEventArgs e) {
                if(!dragging)return; selection=Rectangle.Intersect(ClientRectangle,Rectangle.FromLTRB(Math.Min(origin.X,e.X),Math.Min(origin.Y,e.Y),Math.Max(origin.X,e.X),Math.Max(origin.Y,e.Y))); Invalidate();
            };
            MouseUp += delegate {
                if(!dragging)return; dragging=false;
                if(selection.Width>1&&selection.Height>1) {
                    if(selection.Width>10000||selection.Height>10000||(long)selection.Width*selection.Height>25000000){Close();return;}
                    using(var image=snapshot.Clone(selection,PixelFormat.Format32bppArgb)) image.Save(output,ImageFormat.Png);
                }
                Close();
            };
        }
        protected override void OnPaint(PaintEventArgs e) {
            e.Graphics.DrawImageUnscaled(snapshot,Point.Empty);
            using(var shade=new SolidBrush(Color.FromArgb(110,0,0,0)))e.Graphics.FillRectangle(shade,ClientRectangle);
            if(selection.Width>0&&selection.Height>0) {
                e.Graphics.DrawImage(snapshot,selection,selection,GraphicsUnit.Pixel);
                using(var border=new Pen(Color.FromArgb(65,190,145),2))e.Graphics.DrawRectangle(border,selection);
            }
            using(var font=new Font("Microsoft YaHei UI",14))e.Graphics.DrawString("拖动框选截图 · Esc / 右键取消",font,Brushes.White,24,24);
        }
        protected override void Dispose(bool disposing){if(disposing)snapshot.Dispose();base.Dispose(disposing);}
    }
}
