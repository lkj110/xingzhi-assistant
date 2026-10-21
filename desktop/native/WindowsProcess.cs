// Process-tree lifetime and private ACLs for Windows CLI adapters.
// This is not a sandbox against a malicious program running as the same user.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class WindowsProcess {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x,y,width,height,xChars,yChars,fill,flags;
        public short show, reservedLength; public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime,jobTime; public uint flags; public UIntPtr min,max;
        public uint count; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimit basic; public Io io; public UIntPtr a,b,c,d; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long a,b,c,d; public uint faults,total,active,terminated;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits value,int length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,int length,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    // CommandLineToArgvW/CRT quoting; no cmd.exe, shell interpolation or scripts.
    static string Quote(string value) {
        var b=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') {slashes++;continue;}
            if(c=='"') b.Append('\\',slashes*2+1).Append('"');
            else b.Append('\\',slashes).Append(c);
            slashes=0;
        }
        return b.Append('\\',slashes*2).Append('"').ToString();
    }
    static SecurityIdentifier User() { return WindowsIdentity.GetCurrent().User; }
    static FileSystemSecurity Security(string file) {
        if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new IOException();
        return Directory.Exists(file)?(FileSystemSecurity)Directory.GetAccessControl(file):File.GetAccessControl(file);
    }
    static void Secure(string file) {
        var sid=User(); var directory=Directory.Exists(file);
        FileSystemSecurity rules=directory?(FileSystemSecurity)new DirectorySecurity():new FileSecurity();
        rules.SetOwner(sid);rules.SetAccessRuleProtection(true,false);
        rules.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,
            directory?InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit:InheritanceFlags.None,
            PropagationFlags.None,AccessControlType.Allow));
        if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new IOException();
        if(directory)Directory.SetAccessControl(file,(DirectorySecurity)rules);else File.SetAccessControl(file,(FileSecurity)rules);
    }
    static string Check(string file) {
        var rules=Security(file);var sid=User();bool owner=false;
        if(!rules.GetOwner(typeof(SecurityIdentifier)).Equals(sid))throw new IOException();
        foreach(FileSystemAccessRule rule in rules.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
            if(rule.AccessControlType==AccessControlType.Allow) {
                if(!rule.IdentityReference.Equals(sid))throw new IOException();
                if((rule.FileSystemRights&FileSystemRights.FullControl)==FileSystemRights.FullControl)owner=true;
            }
        }
        if(!owner)throw new IOException();
        return rules.GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner);
    }
    static string EventName(string id) {
        Guid parsed;if(!Guid.TryParseExact(id,"D",out parsed))throw new ArgumentException();
        return @"Local\XingzhiProcess-"+id;
    }
    static int Cancel(string id) {
        var until=DateTime.UtcNow.AddSeconds(2);
        do {try{using(var e=EventWaitHandle.OpenExisting(EventName(id),EventWaitHandleRights.Modify))e.Set();return 0;}
            catch(WaitHandleCannotBeOpenedException){Thread.Sleep(10);}
        }while(DateTime.UtcNow<until);
        return 1;
    }
    static int Run(string[] args) {
        var owner=Process.GetProcessById(int.Parse(args[1]));
        // Force opening a handle now, so PID reuse cannot adopt a different parent.
        var ownerHandle=owner.Handle;
        var security=new EventWaitHandleSecurity();
        security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(new EventWaitHandleAccessRule(User(),EventWaitHandleRights.FullControl,AccessControlType.Allow));
        bool created; using(var cancel=new EventWaitHandle(false,EventResetMode.ManualReset,EventName(args[2]),out created,security)) {
            if(!created)throw new IOException();
            IntPtr job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new IOException();
            var info=new ProcessInfo();
            try {
                var limits=new Limits();limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
                if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)))throw new IOException();
                var command=new StringBuilder();for(int i=3;i<args.Length;i++){if(i>3)command.Append(' ');command.Append(Quote(args[i]));}
                var start=new Startup {cb=Marshal.SizeOf(typeof(Startup)),flags=0x100,stdin=GetStdHandle(-10),stdout=GetStdHandle(-11),stderr=GetStdHandle(-12)};
                if(!CreateProcess(args[3],command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref start,out info))throw new IOException();
                // No application code executes before containment is installed.
                if(!AssignProcessToJobObject(job,info.process)) {TerminateProcess(info.process,254);WaitForSingleObject(info.process,5000);throw new IOException();}
                if(ResumeThread(info.thread)==0xffffffff)throw new IOException();
                bool cancelled=false;
                while(WaitForSingleObject(info.process,20)==258) {
                    if(cancel.WaitOne(0)||WaitForSingleObject(ownerHandle,0)==0) {cancelled=true;if(!TerminateJobObject(job,130))throw new IOException();break;}
                }
                if(WaitForSingleObject(info.process,5000)!=0)throw new IOException();
                uint code;if(!GetExitCodeProcess(info.process,out code))throw new IOException();
                // Even if the leader exits with detached stdio, drain its descendants.
                if(!TerminateJobObject(job,130))throw new IOException();
                var deadline=DateTime.UtcNow.AddSeconds(5);
                while(true) {
                    Accounting value;if(!QueryInformationJobObject(job,1,out value,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new IOException();
                    if(value.active==0)break;
                    if(DateTime.UtcNow>=deadline)throw new IOException();
                    Thread.Sleep(10);
                }
                return cancelled?130:unchecked((int)code);
            } finally {
                // On any exception the Job handle still kills the contained tree.
                CloseHandle(job);
                if(info.thread!=IntPtr.Zero)CloseHandle(info.thread);
                if(info.process!=IntPtr.Zero)CloseHandle(info.process);
                owner.Dispose();
            }
        }
    }
    static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try {
            if(args.Length>=4&&args[0]=="run")return Run(args);
            if(args.Length==2&&args[0]=="cancel")return Cancel(args[1]);
            if(args.Length==2&&args[0]=="secure"){Secure(args[1]);Check(args[1]);return 0;}
            if(args.Length>=2&&args[0]=="check") {
                var values=new string[args.Length-1];for(int i=1;i<args.Length;i++)values[i-1]=Check(args[i]);
                Console.WriteLine(new JavaScriptSerializer().Serialize(values));return 0;
            }
        } catch {Console.Error.WriteLine("Windows process or private-session validation failed.");}
        return 254;
    }
}
