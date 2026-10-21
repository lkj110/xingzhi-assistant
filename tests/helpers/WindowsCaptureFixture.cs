using System;using System.Drawing;using System.Diagnostics;using System.Runtime.InteropServices;using System.Threading;using System.Windows.Forms;using System.Web.Script.Serialization;
class CaptureFixture {
 [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr x);
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr w);
 [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]static extern void mouse_event(uint f,uint x,uint y,uint data,UIntPtr extra);
 [DllImport("user32.dll")]static extern void keybd_event(byte k,byte scan,uint f,UIntPtr extra);
 [DllImport("user32.dll")]static extern bool GetCursorPos(out Point p);
 static readonly JavaScriptSerializer json=new JavaScriptSerializer();
 static void Emit(object value){Console.WriteLine(json.Serialize(value));Console.Out.Flush();}
 [STAThread]static void Main(){
  SetProcessDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();Console.OutputEncoding=new System.Text.UTF8Encoding(false);
  var form=new Form{Text="Xingzhi Windows synthetic capture fixture",StartPosition=FormStartPosition.Manual,Location=new Point(120,100),Size=new Size(700,440),BackColor=Color.White};
  var edit=new TextBox{Text="Windows selection fixture 7200",Multiline=true,Location=new Point(30,35),Size=new Size(610,100),Font=new Font("Arial",20)};
  var paint=new Panel{Location=new Point(30,180),Size=new Size(500,150),BackColor=Color.FromArgb(31,160,100)};
  form.Controls.Add(edit);form.Controls.Add(paint);Point mouse;GetCursorPos(out mouse);
  IDataObject original=null;DataObject saved=new DataObject();bool captured=false;
  form.Shown+=delegate{
   try {original=Clipboard.GetDataObject();if(original!=null)foreach(var format in original.GetFormats(false)){var value=original.GetData(format,false);if(value==null)throw new Exception();saved.SetData(format,false,value);}captured=true;Clipboard.SetText("XINGZHI_CLIPBOARD_SENTINEL");}
   catch{Emit(new {error="Clipboard preservation unavailable"});form.Close();return;}
   var p=paint.PointToScreen(new Point(25,25));
   Emit(new {ready=true,pid=Process.GetCurrentProcess().Id,app=Process.GetCurrentProcess().ProcessName,title=form.Text,handle=form.Handle.ToInt64(),x=p.X,y=p.Y});
  };
  var reader=new Thread(()=>{
   string line;while((line=Console.ReadLine())!=null){var command=line;form.BeginInvoke((MethodInvoker)delegate{
    if(command=="select"){SetForegroundWindow(form.Handle);edit.Focus();edit.Select(0,0);keybd_event(17,0,0,UIntPtr.Zero);keybd_event(65,0,0,UIntPtr.Zero);var timer=new System.Windows.Forms.Timer{Interval=250};timer.Tick+=delegate{timer.Stop();timer.Dispose();keybd_event(65,0,2,UIntPtr.Zero);keybd_event(17,0,2,UIntPtr.Zero);};timer.Start();}
    if(command=="check")Emit(new {clipboardRestored=Clipboard.ContainsText()&&Clipboard.GetText()=="XINGZHI_CLIPBOARD_SENTINEL",selected=edit.SelectedText});
    if(command=="password"){edit.Multiline=false;edit.UseSystemPasswordChar=true;SetForegroundWindow(form.Handle);edit.Focus();edit.SelectAll();Emit(new {password=true});}
    if(command=="pixel"){var p=paint.PointToScreen(new Point(105,65));using(var bitmap=new Bitmap(1,1)){using(var g=Graphics.FromImage(bitmap))g.CopyFromScreen(p,Point.Empty,new Size(1,1));var c=bitmap.GetPixel(0,0);Emit(new {pixel=new int[]{c.R,c.G,c.B,c.A}});}}
    if(command=="drag"){var p=paint.PointToScreen(new Point(25,25));SetCursorPos(p.X,p.Y);mouse_event(2,0,0,0,UIntPtr.Zero);var timer=new System.Windows.Forms.Timer{Interval=160};int step=0;timer.Tick+=delegate{if(step++==0)SetCursorPos(p.X+160,p.Y+80);else{mouse_event(4,0,0,0,UIntPtr.Zero);timer.Stop();timer.Dispose();Emit(new {dragged=true});}};timer.Start();}
    if(command=="quit")form.Close();
   });}
  });reader.IsBackground=true;reader.Start();
  try{Application.Run(form);}finally{if(captured)try{Clipboard.SetDataObject(saved,true);}catch{}SetCursorPos(mouse.X,mouse.Y);}
 }
}
