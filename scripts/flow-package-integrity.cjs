const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/flow'),archive=path.join(root,'release-flow/行知助手-darwin-arm64/行知助手.app/Contents/Resources/app.asar');
const report=JSON.parse(fs.readFileSync(path.join(out,'package-verification.json'),'utf8'));assert.equal(report.passed,true);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const item of report.hashManifest){assert.equal(hash(fs.readFileSync(path.join(root,item.file))),item.sha256,item.file);assert.equal(hash(asar.extractFile(archive,item.file)),item.sha256,item.file);}
for(const file of ['desktop/native/bin/image-ocr','desktop/native/bin/pdf-ocr']){assert.equal(asar.statFile(archive,file).unpacked,true);assert.ok(fs.statSync(path.join(archive+'.unpacked',file)).mode&0o111);}
const local=require('../package.json'),packaged=JSON.parse(asar.extractFile(archive,'package.json'));
for(const key of ['name','version','main','dependencies'])assert.deepEqual(packaged[key],local[key]);
const result={passed:true,version:local.version,verifiedFiles:report.hashManifest.length,runtimeMetadataEqual:true,nativeHelpersUnpacked:true,sha256:hash(fs.readFileSync(archive)),archive,at:new Date().toISOString()};fs.writeFileSync(path.join(out,'final-integrity.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
