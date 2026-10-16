const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
if(process.platform!=='darwin')throw new Error('选区捕获组件须在 macOS 构建');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'desktop/native/bin'),source=path.join(root,'desktop/native/SelectionCapture.swift');
const requested=process.argv.find(arg=>arg.startsWith('--arch='))?.slice(7)||process.arch;
if(!['arm64','x64'].includes(requested))throw new Error('识别组件仅支持 --arch=arm64 或 --arch=x64');
fs.mkdirSync(dir,{recursive:true});const output=path.join(dir,'selection-capture'),temporary=output+'.building';
const stamp=output+'.build.json',digest=crypto.createHash('sha256').update(fs.readFileSync(source)).update(fs.readFileSync(__filename)).update(requested).digest('hex');
const fileHash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try{const saved=JSON.parse(fs.readFileSync(stamp,'utf8'));fs.accessSync(output,fs.constants.X_OK);if(saved.digest===digest&&saved.binaryHash===fileHash(output)){console.log(`Selection capture already built for ${requested}.`);process.exit(0);}}catch{}
try {
  const result=cp.spawnSync('/usr/bin/xcrun',['swiftc',source,'-O','-target',`${requested==='x64'?'x86_64':'arm64'}-apple-macos13.0`,'-framework','AppKit','-framework','ApplicationServices','-o',temporary],{stdio:'inherit',timeout:120000});
  if(result.error||result.status!==0)throw new Error('选区捕获组件编译失败');
  fs.chmodSync(temporary,0o755);fs.renameSync(temporary,output);fs.writeFileSync(stamp,JSON.stringify({digest,binaryHash:fileHash(output),arch:requested,minimumMacOS:'13.0'}));console.log(`Selection capture built for ${requested}; runtime requires macOS 13+ and no developer tools.`);
}finally{fs.rmSync(temporary,{force:true});}
