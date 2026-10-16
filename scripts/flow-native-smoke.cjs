// OS shortcut registration only. No physical key injection or user workspace access.
const {app,globalShortcut,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v20-hotkey-')));
const archive=path.join(root,'release-flow/行知助手-darwin-arm64/行知助手.app/Contents/Resources/app.asar');
app.setPath('userData',dir);
let controller;
app.whenReady().then(()=>{
 const {Assistant}=require(path.join(archive,'desktop/core.cjs'));
 const quick=require(path.join(archive,'desktop/quick-capture.cjs'));
 const a=new Assistant({dir:path.join(dir,'workspace')});
 controller=quick.createController({assistant:a,BrowserWindow,globalShortcut,preload:path.join(archive,'desktop/preload.cjs'),indexFile:path.join(archive,'dist/index.html')});
 assert.equal(controller.status().enabled,false);assert.equal(controller.status().registered,false);
 const checks=['隔离的新工作区默认关闭真实系统快捷键'];let registered=false,reason=null;
 try{controller.configure({enabled:true});registered=globalShortcut.isRegistered(quick.ACCELERATOR);assert.equal(registered,true);checks.push('包内控制器成功向 macOS 注册快捷键，Electron 实际状态为已注册');}
 catch(error){reason=error.message;assert.equal(controller.status().enabled,false);assert.match(reason,/快捷键/);checks.push('系统拒绝注册时保留关闭状态并提供错误说明');}
 controller.configure({enabled:false});assert.equal(globalShortcut.isRegistered(quick.ACCELERATOR),false);checks.push('关闭设置后实际释放 macOS 快捷键');
 const report={passed:true,registered,reason,checks,physicalCrossAppKeystrokeTested:false,actualUserWorkspaceTouched:false};
 fs.mkdirSync(path.join(root,'artifacts/flow'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/flow/quick-capture-native-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{controller?.dispose();fs.rmSync(dir,{recursive:true,force:true});app.exit(process.exitCode||0);});
