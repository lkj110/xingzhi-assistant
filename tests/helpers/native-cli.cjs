'use strict';
// A PE fixture adapter is required on Windows; .cmd/shebang fixtures do not
// exercise CreateProcess, Job Objects or native executable discovery.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const output=path.resolve(__dirname,'../../desktop/native/bin/test-cli.exe');
function ensure(){
 const hash=require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
 if(fs.existsSync(output)&&fs.existsSync(output+'.stamp')&&fs.readFileSync(output+'.stamp','utf8')===hash)return output;
 fs.mkdirSync(path.dirname(output),{recursive:true});
 const source=output+'.cs',node=process.execPath.replace(/"/g,'""');
 fs.writeFileSync(source,`using System;using System.Diagnostics;using System.Text;using System.Threading;class Fixture {
 static string Q(string s){var b=new StringBuilder("\\\"");int n=0;foreach(char c in s){if(c=='\\\\'){n++;continue;}if(c=='"')b.Append('\\\\',n*2+1).Append('"');else b.Append('\\\\',n).Append(c);n=0;}return b.Append('\\\\',n*2).Append('"').ToString();}
 static int Main(string[] args){var b=new StringBuilder(Q(Process.GetCurrentProcess().MainModule.FileName+".cjs"));foreach(var s in args)b.Append(" ").Append(Q(s));var p=Process.Start(new ProcessStartInfo(@"${node}",b.ToString()){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true});var a=new Thread(()=>p.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));var e=new Thread(()=>p.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));var i=new Thread(()=>{try{Console.OpenStandardInput().CopyTo(p.StandardInput.BaseStream);p.StandardInput.Close();}catch{}});i.IsBackground=true;a.Start();e.Start();i.Start();p.WaitForExit();a.Join();e.Join();return p.ExitCode;}
}`);
 cp.execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/out:'+output,source],{stdio:'pipe',windowsHide:true});
 fs.writeFileSync(output+'.stamp',hash);
 return output;
}
function write(file,body){
 if(process.platform!=='win32'){fs.writeFileSync(file,`#!${process.execPath}\n${body}`,{mode:0o700});return file;}
 const executable=file.endsWith('.exe')?file:file+'.exe';
 fs.copyFileSync(ensure(),executable);fs.writeFileSync(executable+'.cjs',body);return executable;
}
module.exports={write};
