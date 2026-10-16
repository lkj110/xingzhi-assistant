const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parseArgs}=require('node:util');
const {Assistant}=require('../desktop/core.cjs');
const {cases,evaluateCase}=require('../desktop/agent-eval.cjs');
const {createSubscriptionModel}=require('./subscription-model.cjs');
const {values}=parseArgs({options:{model:{type:'string'},reasoning:{type:'string',default:'xhigh'},cases:{type:'string',default:'delivery,replan,missing'},out:{type:'string',default:'artifacts/subscription/first-run'}}});
if(!values.model)throw new Error('请使用 --model 指定当前订阅配置的模型');
const selected=values.cases.split(',').map(id=>{const c=cases.find(c=>c.id===id);if(!c)throw new Error(`未知场景 ${id}`);return c;});
const output=path.resolve(values.out);if(fs.existsSync(path.join(output,'report.json')))throw new Error('输出目录已有测试结果，请使用新的 --out 目录');fs.mkdirSync(output,{recursive:true});
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-subscription-eval-')));
const controller=new AbortController();
const model=createSubscriptionModel({model:values.model,reasoning:values.reasoning,logDir:path.join(output,'model-calls'),maxCalls:80,onFailure:()=>controller.abort()});
const parent=new Assistant({dir,chat:model.chat});parent.controller=controller;
const report={startedAt:new Date().toISOString(),model:values.model,reasoning:values.reasoning,authentication:'existing ChatGPT subscription via official Codex CLI',environment:'real inference; real app execution; temporary local files; fixture GitHub',status:'running',requestedCases:selected.map(c=>c.id),cases:[]};
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({...report,calls:model.records.length,completedCalls:model.records.filter(r=>r.status==='completed').length},null,2));
const abort=()=>parent.controller.abort();process.on('SIGINT',abort);process.on('SIGTERM',abort);
const deadline=setTimeout(abort,25*60*1000);
(async()=>{
 try {
  await parent.dispatch('saveProvider',{name:'当前订阅测试',baseUrl:'https://example.invalid/v1',model:values.model}); // The injected CLI adapter handles inference; this address is never requested.
  for(const spec of selected){parent.controller.signal.throwIfAborted();report.activeCase={id:spec.id,title:spec.title,startedAt:new Date().toISOString(),firstCall:model.records.length+1};save();console.log(JSON.stringify({event:'case.started',id:spec.id,title:spec.title}));const started=Date.now();
   const result=await evaluateCase(parent,spec,{capture:async evidence=>{const target=path.join(output,spec.id);fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'evidence.json'),JSON.stringify(evidence,null,2));for(const file of evidence.files)fs.writeFileSync(path.join(target,file.name),file.content);}});
   report.cases.push({...result,durationMs:Date.now()-started});delete report.activeCase;save();console.log(JSON.stringify({event:'case.completed',...report.cases.at(-1)}));
  }
  report.status='completed';
 } catch(error){report.status=parent.controller.signal.aborted?'stopped':'failed';report.error=model.records.at(-1)?.error||error.message;process.exitCode=1;}
 finally {clearTimeout(deadline);report.finishedAt=new Date().toISOString();report.passed=report.cases.filter(c=>c.passed).length;save();model.close();fs.rmSync(dir,{recursive:true,force:true});console.log(JSON.stringify({...report,calls:model.records.length,output}));if(report.cases.some(c=>!c.passed))process.exitCode=1;}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
