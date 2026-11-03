'use strict';
const fs=require('node:fs'),path=require('node:path');
const appId='local.xingzhi.assistant',toastId='{9CB14368-0A71-4D19-8CC7-20B58B091361}';
// Electron can register a shared shortcut/COM activator even from
// Notification.isSupported(). Only the packaged default profile owns them.
function canRegisterWindowsShell(app){
 return app?.isPackaged===true&&app.commandLine?.hasSwitch?.('user-data-dir')===false;
}
function configure(app){
 if(!canRegisterWindowsShell(app))return false;
 app.setAppUserModelId(appId);app.setToastActivatorCLSID(toastId);return true;
}
function shortcut({app,shell,directory}){
 if(!canRegisterWindowsShell(app))return null;
 directory??=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs');
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'行知助手.lnk');
 if(!shell.writeShortcutLink(file,'create',{target:process.execPath,cwd:path.dirname(process.execPath),description:'行知助手 · 个人工作助手',icon:process.execPath,iconIndex:0,appUserModelId:appId,toastActivatorClsid:toastId}))throw Error('无法创建行知助手开始菜单入口');
 return file;
}
module.exports={configure,shortcut,canRegisterWindowsShell,appId,toastId};
