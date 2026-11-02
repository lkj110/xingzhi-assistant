using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Harmless fixture, always ordinary-user. File handshake lets the controller
// acquire real OS process handles before very short-lived workers can exit.
public static class FoundationProcessFixture {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string[] Names = {"root1","child","grandchild","root2","leaf0","leaf1","leaf2","leaf3","leaf4","leaf5"};
    static string directory;
    static string session;
    static string FileFor(string name) { return Path.Combine(directory,name); }
    static void Write(string name, object value) {
        string temp=FileFor(name+".tmp");
        using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
            byte[] data=new UTF8Encoding(false).GetBytes(Json.Serialize(value)+"\n");
            stream.Write(data,0,data.Length);stream.Flush(true);
        }
        File.Move(temp,FileFor(name));
    }
    static void Wait(string name) {
        var clock=Stopwatch.StartNew();
        while(!File.Exists(FileFor(name))) { if(clock.ElapsedMilliseconds>15000)throw new TimeoutException(name);Thread.Sleep(10); }
    }
    static string Quote(string value) {
        // No user arguments or commands are accepted. These validated paths
        // cannot contain quotes; double terminal backslashes before the quote.
        if(value.Contains("\""))throw new ArgumentException("Quote in path");
        return "\""+value.TrimEnd('\\')+new string('\\',2*(value.Length-value.TrimEnd('\\').Length))+"\"";
    }
    static Process Launch(string name) {
        var p=new Process();
        p.StartInfo=new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
            "worker "+Quote(directory)+" "+session+" "+name+" "+Process.GetCurrentProcess().Id) {
            UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden
        };
        if(!p.Start())throw new Exception("Spawn failed");return p;
    }
    static void Worker(string name, int parent) {
        if(!Names.Contains(name))throw new ArgumentException("Unknown worker");
        var self=Process.GetCurrentProcess();
        Write(name+".start.json",new {name=name,pid=self.Id,ppid=parent,session=session,startTime=self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()});
        Wait(name+".ack");
        if(name=="root1") {
            using(var child=Launch("child")) { Wait("child.ack"); }
            return;
        }
        if(name=="child") {
            Wait("root1.exited");
            using(var grandchild=Launch("grandchild")) {
                Wait("grandchild.ack");grandchild.WaitForExit();if(grandchild.ExitCode!=0)throw new Exception("Grandchild failed");
            }
            return;
        }
        if(name=="root2") {
            var children=new List<Process>();
            for(int i=0;i<6;i++)children.Add(Launch("leaf"+i));
            foreach(var child in children) { child.WaitForExit();if(child.ExitCode!=0)throw new Exception("Leaf failed");child.Dispose(); }
            return;
        }
        Thread.Sleep(20);
    }
    static void Controller() {
        var owned=new Dictionary<string,Process>();
        var starts=new Dictionary<string,Dictionary<string,object>>();
        var receipts=new List<object>();
        var exited=new HashSet<string>();
        var root1=Launch("root1");owned.Add("root1",root1);
        var clock=Stopwatch.StartNew();
        while(exited.Count<Names.Length) {
            if(clock.ElapsedMilliseconds>45000)throw new TimeoutException("Fixture deadline");
            foreach(string name in Names) {
                if(!starts.ContainsKey(name)&&File.Exists(FileFor(name+".start.json"))) {
                    var data=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(FileFor(name+".start.json")));
                    if((string)data["session"]!=session)throw new Exception("Fixture identity changed");
                    int pid=Convert.ToInt32(data["pid"]);
                    if(!owned.ContainsKey(name))owned.Add(name,Process.GetProcessById(pid));
                    var p=owned[name];var handle=p.Handle; // Hold this instance, never re-open by reused PID.
                    if(p.Id!=pid||p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()!=(string)data["startTime"])throw new Exception("PID instance mismatch");
                    starts.Add(name,data);Write(name+".ack",new {pid=pid});
                }
                if(starts.ContainsKey(name)&&!exited.Contains(name)&&owned[name].HasExited) {
                    var p=owned[name];p.WaitForExit();
                    var receipt=new Dictionary<string,object>(starts[name]);
                    receipt["exitTime"]=p.ExitTime.ToUniversalTime().ToFileTimeUtc().ToString();receipt["exitCode"]=p.ExitCode;
                    receipts.Add(receipt);exited.Add(name);
                    if(p.ExitCode!=0)throw new Exception("Nonzero worker exit: "+name);
                    Write(name+".exited",new {pid=p.Id,exitCode=p.ExitCode});
                    if(name=="root1")owned.Add("root2",Launch("root2"));
                }
            }
            Thread.Sleep(5);
        }
        Write("fixture.json",new {schema=1,session=session,controllerPid=Process.GetCurrentProcess().Id,
            administrative=false,expected=Names.Length,complete=true,processes=receipts});
        foreach(var p in owned.Values)p.Dispose();
    }
    public static int Main(string[] args) {
        try {
            var principal=new WindowsPrincipal(WindowsIdentity.GetCurrent());
            if(principal.IsInRole(WindowsBuiltInRole.Administrator))throw new Exception("FIXTURE_MUST_NOT_BE_ADMIN");
            if(args.Length!=3&&args.Length!=5)throw new ArgumentException("Invalid arguments");
            directory=Path.GetFullPath(args[1]);session=args[2];
            if(directory!=args[1]||!Directory.Exists(directory)||!System.Text.RegularExpressions.Regex.IsMatch(session,"^[a-f0-9]{32}$"))throw new Exception("Invalid session");
            for(var info=new DirectoryInfo(directory);info!=null;info=info.Parent)if((info.Attributes&FileAttributes.ReparsePoint)!=0)throw new Exception("Reparse path");
            if(args[0]=="controller"&&args.Length==3)Controller();
            else if(args[0]=="worker"&&args.Length==5)Worker(args[3],Int32.Parse(args[4]));
            else throw new ArgumentException("Unknown mode");
            return 0;
        } catch(Exception error) {
            Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 2;
        }
    }
}
