const path=require('node:path'),fs=require('node:fs'),core=require('../desktop/core.cjs'),Base=core.Assistant,dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw Error('Isolated test data required');
const calls={models:0,external:0,clipboard:0,shortcutRegisters:0},electron=require('electron');let shortcut=null,conflict=true,trayMenu=null;
electron.globalShortcut.register=(_key,fn)=>{calls.shortcutRegisters++;if(conflict)return false;shortcut=fn;return true;};electron.globalShortcut.isRegistered=()=>!!shortcut;electron.globalShortcut.unregister=()=>{shortcut=null;};
for(const method of ['readText','readHTML','readRTF','readImage','readBuffer'])electron.clipboard[method]=()=>{calls.clipboard++;throw Error('Automatic clipboard access prohibited');};
const setTrayMenu=electron.Tray.prototype.setContextMenu;electron.Tray.prototype.setContextMenu=function(menu){trayMenu=menu;return setTrayMenu.call(this,menu);};
electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async()=>{calls.models++;await new Promise(resolve=>setTimeout(resolve,1800));throw Error('Fixture model deliberately unavailable');},agentRequest:async()=>{calls.external++;throw Error('External calls prohibited');},connectorRequest:async()=>{calls.external++;throw Error('External calls prohibited');}});}
 tick(){}
 save(){if(this.failNextSave){this.failNextSave=false;throw Error('隔离测试：磁盘暂时写入失败');}return super.save();}
 async dispatch(action,input={}){
  if(action==='fixtureQuickStats')return {...calls,shortcutRegistered:!!shortcut,tray:trayMenu?.items.map(item=>item.label)};
  if(action==='fixtureQuickConflict'){conflict=input.enabled===true;return {ok:true};}
  if(action==='fixtureQuickTrigger'){if(input.via==='tray')trayMenu.items.find(item=>item.label==='快速收集').click();else if(shortcut)shortcut();else throw Error('Shortcut not registered');return {ok:true};}
  if(action==='fixtureQuickBusy')return this.launch('已有事项正在推进',()=>new Promise(resolve=>{this.fixtureRelease=resolve;}));
  if(action==='fixtureQuickRelease'){this.fixtureRelease?.();await this.runPromise;Base.prototype.tick.call(this);await this.runPromise;return this.publicState();}
  if(action==='fixtureQuickDrain'){Base.prototype.tick.call(this);await this.runPromise;return this.publicState();}
  if(action==='fixtureQuickFailSave'){this.failNextSave=true;return {ok:true};}
  return super.dispatch(action,input);
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'隔离整理模型',model:'fixture',baseUrl:'https://fixture.invalid/v1'});await a.dispatch('projectSave',{name:'快速收集项目'});await a.dispatch('projectSave',{name:'已归档项目'});a.data.projects.find(p=>p.name==='已归档项目').archivedAt=new Date().toISOString();a.save();require('../desktop/main.cjs');})().catch(error=>{console.error(error);electron.app.exit(1);});
