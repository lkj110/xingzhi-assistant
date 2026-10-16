const path=require('node:path'),core=require('../desktop/core.cjs'),Base=core.Assistant,electron=require('electron');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw Error('Isolated data required');let models=0,external=0;
const deny=async()=>{external++;throw Error('External network disabled in fixture');};
const reply=(tool,args={})=>({tool,args,reason:'项目材料规则界面验收'});
core.Assistant=class extends Base{
 constructor(options){super({...options,agentRequest:deny,connectorRequest:deny,feedRequest:deny,webRequest:deny,chat:async(_p,_k,messages)=>{
  models++;const prompt=messages[0].content,ctx=JSON.parse(messages[1].content);
  if(prompt.includes('动作格式')){const task=ctx.tasks[0];if(!task||task.needsReplan)return reply('plan_task',{key:'project-note',title:'青禾资料摘要',description:'按当前材料核对预算',criteria:'摘要包含当前预算',sourceIds:ctx.sources.filter(s=>s.current!==false).map(s=>s.id),steps:[{key:'draft',title:'整理资料摘要',kind:'draft'}],...(task?{resetSteps:['draft'],reason:'材料已更新'}:{})});if(task.status==='completed')return reply('complete');return reply('advance_task',{taskId:task.id});}
  if(prompt.includes('推进给定事项'))return {kind:'artifact',title:'青禾资料摘要',content:`当前预算 ${ctx.sources.some(s=>s.content.includes('7200'))?'7200':'6800'} 元。`};
  if(prompt.includes('提取')&&!prompt.includes('独立'))return {tasks:[],summary:'保留背景资料'};
  return {passed:true,summary:'按当前材料核对通过',gaps:[]};
 }});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureUnifiedImageFolder'){const folder={id:'ui-image-folder',name:'图片资料',path:input.path,enabled:true,projectId:this.data.projects.find(p=>p.name==='资料自动处理').id};this.data.folders.push(folder);return super.dispatch('folderConfigure',folder);}
  if(action==='fixtureUnifiedStats')return {models,external};
  if(action==='fixtureUnifiedRevision'){const p=this.data.projects.find(p=>p.name==='资料自动处理');return super.dispatch('import',{items:[{projectId:p.id,title:'青禾说明',content:'青禾预算更新为7200元。'}]});}
  if(action==='fixtureUnifiedIdle'){await this.runPromise;return this.publicState();}
  return super.dispatch(action,input);
 }
};
(async()=>{const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,cachedInputPrice:0,name:'隔离测试模型',model:'fixture',baseUrl:'https://fixture.invalid/v1'});await a.dispatch('projectSave',{name:'资料自动处理'});const p=a.data.projects[0];await a.dispatch('import',{items:[{projectId:p.id,title:'青禾说明',content:'青禾预算为6800元。'}]});await a.dispatch('projectSave',{name:'其他项目'});await a.dispatch('import',{items:[{projectId:a.data.projects[0].id,title:'其他资料',content:'其他项目私有资料不进入主规则。'}]});electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');})().catch(e=>{console.error(e);electron.app.exit(1);});
