using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Separate, read-only observer. No process launch, model, application or ACL API.
public sealed class FoundationProcessObserver : IDisposable {
    readonly object sync = new object();
    readonly StreamWriter output;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly List<ManagementEventWatcher> watchers = new List<ManagementEventWatcher>();
    readonly HashSet<string> stopping = new HashSet<string>();
    readonly HashSet<string> stopped = new HashSet<string>();
    readonly string session;
    int sequence;
    volatile bool failed;
    bool disposed;
    int callbacks;
    public bool Failed { get { return failed; } }
    public FoundationProcessObserver(string file, string sessionId) {
        session = sessionId;
        output = new StreamWriter(new FileStream(file, FileMode.CreateNew, FileAccess.Write,
            FileShare.Read, 4096, FileOptions.WriteThrough), new UTF8Encoding(false));
        output.AutoFlush = true;
        Emit("begin", new Dictionary<string, object>());
    }
    void Emit(string kind, Dictionary<string, object> row) {
        lock(sync) {
            if(disposed) { failed = true; return; }
            row["kind"] = kind; row["seq"] = ++sequence; row["session"] = session;
            row["at"] = DateTime.UtcNow.ToString("o"); row["monoMs"] = clock.ElapsedMilliseconds;
            row["fileTime"] = DateTime.UtcNow.ToFileTimeUtc().ToString();
            try { output.WriteLine(json.Serialize(row)); } catch { failed = true; throw; }
        }
    }
    void Fail(string reason, string detail) {
        failed = true;
        try { Emit("fault", new Dictionary<string, object>{{"reason",reason},{"detail",detail}}); } catch { }
    }
    public void Start() {
        // __EventQueueOverflowEvent derives from __EventDroppedEvent. All such
        // notifications are conservatively fatal; they do not prove no silent loss.
        string[] classes = {"__EventDroppedEvent", "__ConsumerFailureEvent", "Win32_ProcessStopTrace", "Win32_ProcessStartTrace"};
        try {
            foreach(string name in classes) {
                string key = name;
                var watcher = new ManagementEventWatcher("root\\cimv2", "SELECT * FROM " + name);
                watcher.EventArrived += (sender, args) => {
                    lock(sync) { callbacks++; }
                    try {
                        if(key.StartsWith("__")) { Fail("WMI_EVENT_LOSS", key); return; }
                        var e = args.NewEvent;
                        var row = new Dictionary<string, object> {
                            {"eventTime", Convert.ToUInt64(e["TIME_CREATED"]).ToString()},
                            {"pid", Convert.ToUInt32(e["ProcessID"])},
                            {"ppid", Convert.ToUInt32(e["ParentProcessID"])},
                            {"name", Convert.ToString(e["ProcessName"])},
                            {"sessionId", Convert.ToUInt32(e["SessionID"])}
                        };
                        if(key == "Win32_ProcessStopTrace") row["exitCode"] = Convert.ToUInt32(e["ExitStatus"]);
                        Emit(key == "Win32_ProcessStartTrace" ? "start" : "stop", row);
                    } catch(Exception e) { Fail("EVENT_CALLBACK", e.GetType().Name + ": " + e.Message); }
                    finally { lock(sync) { callbacks--; } }
                };
                watcher.Stopped += (sender, args) => {
                    bool expected;
                    lock(sync) {
                        expected = stopping.Contains(key) && args.Status == ManagementStatus.OperationCanceled;
                        if(!stopped.Add(key)) expected = false;
                    }
                    try { Emit("subscriptionStopped", new Dictionary<string, object>{{"subscription",key},{"expected",expected},{"status",args.Status.ToString()}}); } catch { }
                    if(!expected) Fail("SUBSCRIPTION_STOPPED", key + ": " + args.Status);
                };
                watchers.Add(watcher); watcher.Start();
                if(failed) throw new InvalidOperationException("Subscription stopped during registration");
                Emit("subscribed", new Dictionary<string, object>{{"subscription",key}});
            }
            if(failed) throw new InvalidOperationException("Observer failed before ready");
            Emit("ready", new Dictionary<string, object>{{"subscriptions",classes}});
        } catch(Exception e) { Fail("REGISTRATION_FAILED", e.GetType().Name + ": " + e.Message); throw; }
    }
    public void Pulse() { Emit("heartbeat", new Dictionary<string, object>{{"healthy",!failed}}); }
    public void CancelForTest() {
        // Deliberately NOT in 'stopping': the real Stopped callback must fail.
        Emit("cancelTest", new Dictionary<string, object>());
        watchers[watchers.Count - 1].Stop();
    }
    public void Finish(string reason) {
        if(reason != "stop") Fail("UNCLEAN_END", reason);
        Emit("closing", new Dictionary<string, object>{{"reason",reason}});
        string[] classes = {"__EventDroppedEvent", "__ConsumerFailureEvent", "Win32_ProcessStopTrace", "Win32_ProcessStartTrace"};
        for(int i=0;i<watchers.Count;i++) {
            lock(sync) { stopping.Add(classes[i]); }
            try { watchers[i].Stop(); } catch(Exception e) { Fail("STOP_FAILED", e.Message); }
        }
        var wait = Stopwatch.StartNew();
        while(wait.ElapsedMilliseconds < 2000) {
            lock(sync) { if(stopped.Count == watchers.Count) break; }
            Thread.Sleep(20);
        }
        lock(sync) { if(stopped.Count != watchers.Count) Fail("STOP_ACK_MISSING", stopped.Count.ToString()); }
        foreach(var watcher in watchers) watcher.Dispose();
        watchers.Clear();
        wait.Restart();
        while(wait.ElapsedMilliseconds<2000) {
            lock(sync) { if(callbacks==0)break; }
            Thread.Sleep(20);
        }
        lock(sync) { if(callbacks!=0)Fail("CALLBACK_DRAIN_TIMEOUT",callbacks.ToString()); }
        Emit("closed", new Dictionary<string, object>{{"reason",reason},{"healthy",!failed}});
    }
    public void Dispose() {
        foreach(var watcher in watchers) { try { watcher.Dispose(); } catch { failed=true; } }
        lock(sync) { disposed=true; output.Dispose(); }
    }
    static string Hash(byte[] bytes) {
        using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
    }
    static void PlainPath(string path) {
        for(var info=new DirectoryInfo(path);info!=null;info=info.Parent)
            if((info.Attributes&FileAttributes.ReparsePoint)!=0)throw new Exception("REPARSE_POINT_REJECTED");
    }
    static string ReadPlain(string file) {
        if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new Exception("REPARSE_FILE_REJECTED");
        return File.ReadAllText(file);
    }
    public static int Main(string[] args) {
        FoundationProcessObserver observer=null;int code=2;
        // Includes registration. A hung WMI call must not leave a privileged
        // helper running indefinitely. This can only terminate this process.
        using(var watchdog=new Timer(unused=>Environment.Exit(3),null,120000,Timeout.Infinite)) {
            try {
                if(args.Length!=3)throw new Exception("INVALID_ARGUMENTS");
                var principal=new WindowsPrincipal(WindowsIdentity.GetCurrent());
                if(!principal.IsInRole(WindowsBuiltInRole.Administrator))throw new Exception("OBSERVER_ADMIN_REQUIRED");
                string dir=Path.GetFullPath(args[0]),id=args[1],seal=args[2];
                if(dir!=args[0]||!Directory.Exists(dir)||!System.Text.RegularExpressions.Regex.IsMatch(id,"^[a-f0-9]{32}$")||!System.Text.RegularExpressions.Regex.IsMatch(seal,"^[a-f0-9]{64}$"))throw new Exception("SESSION_DIRECTORY_INVALID");
                PlainPath(dir);
                string manifestFile=Path.Combine(dir,"session.json");
                ReadPlain(manifestFile);byte[] bytes=File.ReadAllBytes(manifestFile);
                if(Hash(bytes)!=seal)throw new Exception("SESSION_MANIFEST_CHANGED");
                var manifest=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes));
                string self=Process.GetCurrentProcess().MainModule.FileName;
                PlainPath(Path.GetDirectoryName(self));
                if((File.GetAttributes(self)&FileAttributes.ReparsePoint)!=0)throw new Exception("REPARSE_EXE_REJECTED");
                if((string)manifest["session"]!=id||(string)manifest["observerSha256"]!=Hash(File.ReadAllBytes(self)))throw new Exception("SESSION_IDENTITY_MISMATCH");
                if(File.Exists(Path.Combine(dir,"events.jsonl"))||File.Exists(Path.Combine(dir,"control.json")))throw new Exception("SESSION_ALREADY_USED");
                observer=new FoundationProcessObserver(Path.Combine(dir,"events.jsonl"),id);
                observer.Start();var clock=Stopwatch.StartNew();long pulse=-1000;string reason="timeout";
                while(clock.ElapsedMilliseconds<115000) {
                    if(observer.Failed){reason="observer-fault";break;}
                    if(clock.ElapsedMilliseconds-pulse>=1000){observer.Pulse();pulse=clock.ElapsedMilliseconds;}
                    string controlFile=Path.Combine(dir,"control.json");
                    if(File.Exists(controlFile)) {
                        var control=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(ReadPlain(controlFile));
                        if((string)control["session"]!=id)throw new Exception("CONTROL_IDENTITY_MISMATCH");
                        string action=(string)control["action"];
                        if(action=="stop"){reason="stop";break;}
                        if(action=="cancel"){observer.CancelForTest();Thread.Sleep(300);reason="cancel-test";break;}
                        throw new Exception("UNKNOWN_CONTROL_ACTION");
                    }
                    Thread.Sleep(100);
                }
                observer.Finish(reason);code=!observer.Failed&&reason=="stop"?0:2;
            } catch(Exception error) {
                if(observer!=null)observer.Fail("HOST_ERROR",error.GetType().Name+": "+error.Message);
                Console.Error.WriteLine(error.GetType().Name+": "+error.Message);code=2;
            } finally { if(observer!=null){observer.Dispose();if(observer.Failed)code=2;} }
            return code;
        }
    }
}
