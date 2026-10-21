'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'desktop/native/bin');
function build() {
  if(process.platform!=='win32')throw Error('Windows native helpers must be built on Windows');
  const framework=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
  const csc=path.join(framework,'csc.exe');
  for(const [name,file] of [['windows-capture','WindowsCapture.cs'],['windows-process','WindowsProcess.cs']]){
  const source=path.join(root,'desktop/native',file);
  const output=path.join(dir,name+'.exe'),stamp=output+'.build.json';
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const digest=hash(source)+hash(__filename);
  try{const saved=JSON.parse(fs.readFileSync(stamp));if(saved.digest===digest&&saved.binaryHash===hash(output))continue;}catch{}
  fs.mkdirSync(dir,{recursive:true});
  const result=cp.spawnSync(csc,['/nologo','/target:exe','/platform:anycpu','/optimize+',`/out:${output}`,
    '/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',
    `/reference:${path.join(framework,'WPF','UIAutomationClient.dll')}`,
    `/reference:${path.join(framework,'WPF','UIAutomationTypes.dll')}`,
    `/reference:${path.join(framework,'WPF','WindowsBase.dll')}`,source],{stdio:'inherit',windowsHide:true,timeout:60000});
  if(result.error||result.status!==0)throw Error('Windows capture helper compilation failed; .NET Framework 4.8 is required');
  fs.writeFileSync(stamp,JSON.stringify({digest,binaryHash:hash(output)}));
  console.log(name+' built.');
  }
}
module.exports={build};
if(require.main===module)build();
