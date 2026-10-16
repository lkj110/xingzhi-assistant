// Runs the packaged core and document workers using Electron with isolated temporary data.
const {app}=require('electron');const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),archive=path.join(root,'release-projects/行知助手-darwin-arm64/行知助手.app/Contents/Resources/app.asar');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-package-check-'));app.setPath('userData',dir);
app.whenReady().then(async()=>{try{
const {Assistant}=require(path.join(archive,'desktop/core.cjs'));const a=new Assistant({dir:path.join(dir,'workspace')});
await a.dispatch('projectSave',{name:'打包验证',background:'隔离测试'});await a.dispatch('importDocuments',{projectId:a.data.projects[0].id,items:['project.pdf','project.docx'].map(title=>({title,base64:fs.readFileSync(path.join(root,'tests/fixtures',title)).toString('base64')}))});
assert.equal(a.data.sources.length,2);assert.equal(a.data.sources.find(s=>s.format==='pdf').segments[1].page,2);assert.equal(a.data.sources.find(s=>s.format==='docx').segments[1].paragraph,2);const login=await a.dispatch('subscriptionStatus');assert.equal(login.installed,true);assert.equal(login.loggedIn,true);
for(const key of ['name','version','main','dependencies'])assert.deepEqual(require(path.join(archive,'package.json'))[key],require('../package.json')[key]);
const files=[...fs.readdirSync(path.join(root,'desktop')).filter(n=>n.endsWith('.cjs')).map(n=>'desktop/'+n),'dist/index.html',...fs.readdirSync(path.join(root,'dist/assets')).map(n=>'dist/assets/'+n)];for(const file of files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),crypto.createHash('sha256').update(fs.readFileSync(path.join(archive,file))).digest('hex'),file);
const report={passed:true,version:require(path.join(archive,'package.json')).version,checks:['打包后的 PDF 与 DOCX Worker 实际解析成功','打包后的 Codex 登录检测成功','包内主进程与前端资源同源码一致'],verifiedFiles:files.length};fs.mkdirSync(path.join(root,'artifacts/projects'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/projects/package-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){console.error(e);process.exitCode=1;}finally{fs.rmSync(dir,{recursive:true,force:true});app.exit(process.exitCode||0);}});
