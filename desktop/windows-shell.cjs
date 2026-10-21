'use strict';
const fs=require('node:fs'),path=require('node:path');
const appId='local.xingzhi.assistant',toastId='{9CB14368-0A71-4D19-8CC7-20B58B091361}';
function configure(app){app.setAppUserModelId(appId);app.setToastActivatorCLSID(toastId);}
function shortcut({app,shell,directory=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs')}){
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'行知助手.lnk');
 if(!shell.writeShortcutLink(file,'create',{target:process.execPath,cwd:path.dirname(process.execPath),description:'行知助手 · 个人工作助手',icon:process.execPath,iconIndex:0,appUserModelId:appId,toastActivatorClsid:toastId}))throw Error('无法创建行知助手开始菜单入口');
 return file;
}
module.exports={configure,shortcut,appId,toastId};
