const path=require('path'),fs=require('fs');const root=path.resolve(__dirname,'..'),dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw Error('Isolated data required');
const screenshots=require(path.join(root,'desktop/screenshot.cjs')),originalScreenshot=screenshots.create;screenshots.create=o=>originalScreenshot({...o,clipboard:{readImage:()=>electron.nativeImage.createFromPath(path.join(dir,'images/synthetic.png'))},run:(_bin,args,_opts,cb)=>{fs.copyFileSync(path.join(dir,'images/synthetic.png'),args.at(-1));cb(null);}});
const core=require(path.join(root,'desktop/core.cjs')),Base=core.Assistant,electron=require('electron');let calls=0,external=0,selection;
const deny=async()=>{external++;throw Error('No external transport in audit');};
electron.Notification=class{static isSupported(){return false;}on(){}show(){}};
electron.globalShortcut.register=()=>true;electron.globalShortcut.isRegistered=()=>true;electron.globalShortcut.unregister=()=>{};
require(path.join(root,'desktop/selection-capture.cjs')).create=o=>{selection=o;const status=()=>({selectionEnabled:true,selectionRunning:true,screenshotEnabled:true,screenshotRegistered:true,accessibilityTrusted:true,screenPermission:'granted'});return {reconcile:status,status,configure:status,dispose(){},screenshot:deny,resolve:deny};};
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async(_p,_k,m,o)=>{calls++;o?.onUsage?.({inputTokens:100,outputTokens:50,cachedInputTokens:20});const system=m[0].content,c=JSON.parse(m[1].content),t=c.tasks?.[0]||c.task;
 if(system.includes('动作格式')){if(t?.intake?.status==='pending')return {tool:'plan_task',args:{key:t.agentKey,existingTaskId:t.id,title:'审计事项：整理交接摘要',description:'周五发布，验收负责人林悦。',objective:'提供一页交接摘要',criteria:'明确周五发布和林悦负责验收',reason:'从用户原文提炼背景和目标',sourceIds:t.sourceIds,steps:[{key:'draft',title:'整理交接摘要',kind:'draft'}]}};if(t&&!t.steps.every(s=>s.done))return {tool:'advance_task',args:{taskId:t.id}};return {tool:'complete',args:{summary:'摘要已完成，等待用户验收'}};}
 if(system.includes('推进给定事项'))return {kind:'artifact',title:'交接摘要',content:'# 交接摘要\n周五发布，林悦负责验收。\n对外节点为交接摘要。'};
 if(system.includes('从材料提取'))return {tasks:[{title:'截图预算核对',criteria:'预算7200',sourceIds:c.sources.map(s=>s.id),steps:[{title:'核对预算',kind:'analysis'}]}]};
 return {passed:true,summary:'已核对原文要求',gaps:[]};},agentRequest:deny,connectorRequest:deny,officeRequest:deny,platformRequest:deny});}
 tick(){}
 async dispatch(action,input={}){if(action==='auditDrain'){for(let n=0;n<8;n++){Base.prototype.tick.call(this);await this.runPromise;}return this.publicState();}
 if(action==='auditStats')return {calls,external};
 if(action==='auditSelection'){selection.openCapture({text:input.text,provenance:{kind:'selection',appName:'测试编辑器',windowTitle:'测试窗口',url:'https://example.invalid/audit',capturedAt:new Date().toISOString()}},true);return {opened:true};}
 if(action==='auditQuestion'){const j=this.data.delegations.find(j=>j.id===input.jobId);await require(path.join(root,'desktop/agent.cjs')).act(this,j,'ask',{key:'audit-question',question:'交接文档采用哪种交付形式？',options:[{id:'concise',label:'一页摘要',description:'突出交接核心',recommended:true},{id:'detailed',label:'完整说明',description:'保留详细依据'}]});this.save();return this.publicState();}
 return super.dispatch(action,input);}
};
require(path.join(root,'desktop/main.cjs'));
