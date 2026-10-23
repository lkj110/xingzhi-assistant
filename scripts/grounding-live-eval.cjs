'use strict';
// Real inference, production Assistant.advance, synthetic evidence only.
// Gold fields are used after execution and never enter application messages.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {parseArgs}=require('node:util');
const {Assistant}=require('../desktop/core.cjs'),subscription=require('../desktop/subscription.cjs');
const {cases}=require('./grounding-eval-cases.cjs'),metrics=require('./grounding-eval-metrics.cjs');
const {values}=parseArgs({options:{model:{type:'string'},reasoning:{type:'string',default:'medium'},out:{type:'string'},cases:{type:'string'},concurrency:{type:'string',default:'2'},'max-calls':{type:'string',default:'140'},'arm-calls':{type:'string',default:'6'},lane:{type:'string',default:'all'}}});
if(!values.model||!values.out)throw Error('Specify --model and a new --out directory');
const output=path.resolve(values.out),limit=Number(values['max-calls']),armLimit=Number(values['arm-calls']);
if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(armLimit)||armLimit<1)throw Error('Invalid call limit');
fs.mkdirSync(output,{recursive:true});
const reportPath=path.join(output,'report.json'),now=()=>new Date().toISOString(),digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const requested=values.cases?cases.filter(c=>values.cases.split(',').includes(c.id)):cases;
if(!requested.length)throw Error('No cases selected');
const plan=[];
if(['all','e2e'].includes(values.lane))for(const spec of requested)plan.push({caseId:'e2e:'+spec.id,lane:'e2e',spec});
if(['all','fixed'].includes(values.lane))for(const spec of requested.filter(c=>c.wrongAnswer).slice(0,4))for(const bad of [false,true])plan.push({caseId:`fixed-${bad?'incorrect':'correct'}:${spec.id}`,lane:'fixed',spec,
 candidate:JSON.stringify({answer:bad?spec.wrongAnswer:spec.expected.answers[0],certainty:spec.expected.certainty,basis:bad?'根据资料中的登记或讨论信息确定。':'已综合当前有效资料、例外条件和版本信息。'}),goldCandidateCorrect:!bad});
// Never resume into a report produced by a different implementation or budget.
const fileHash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const implementationFiles=[];
function collect(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())collect(file);else if(name.endsWith('.cjs'))implementationFiles.push([path.relative(path.join(__dirname,'..'),file).replace(/\\/g,'/'),fileHash(file)]);}}
collect(path.join(__dirname,'../desktop'));
for(const name of ['grounding-live-eval.cjs','grounding-eval-cases.cjs','grounding-eval-metrics.cjs'])implementationFiles.push(['scripts/'+name,fileHash(path.join(__dirname,name))]);
const implementation={fingerprint:digest(implementationFiles),nodeVersion:process.version,files:implementationFiles};
const identity=digest({model:values.model,reasoning:values.reasoning,plan,implementation,limit,armLimit,concurrency:values.concurrency});
let report=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath,'utf8')):{schema:1,identity,model:values.model,reasoning:values.reasoning,startedAt:now(),authentication:'existing ChatGPT subscription through production Codex adapter',syntheticOnly:true,liveExternalActions:false,
 design:{pairs:plan.length,e2ePairs:plan.filter(p=>p.lane==='e2e').length,fixedCandidatePairs:plan.filter(p=>p.lane==='fixed').length,order:'alternating baseline/strict first within pairs',concurrency:Math.min(2,Math.max(1,Number(values.concurrency)||1)),maxCalls:limit,armCallLimit:armLimit,deliveryMeaning:'production result verification passed; no external publication',metricsCaveat:'Gold answer/uncertainty scoring is an operational proxy. Basis prose is additionally audited, not scored by the tested model.'},rows:[],calls:[]};
if(report.identity!==identity)throw Error('Existing report belongs to a different immutable plan');
report.implementation=implementation;
const save=()=>{
 report.updatedAt=now();report.summaries=Object.fromEntries(['e2e','fixed'].map(lane=>[lane,metrics.summarize(report.rows.filter(r=>r.lane===lane))]));
 fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
};
const controller=new AbortController();process.on('SIGINT',()=>controller.abort());process.on('SIGTERM',()=>controller.abort());
const totals=records=>{
 const value={};for(const key of ['inputTokens','outputTokens','cachedInputTokens'])value[key]=records.every(r=>Number.isFinite(r.usage?.[key]))?records.reduce((n,r)=>n+r.usage[key],0):null;
 return value;
};
async function runArm(pair,arm){
 if(report.rows.some(r=>r.caseId===pair.caseId&&r.arm===arm))return;
 controller.signal.throwIfAborted();
 const started=Date.now(),tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.realpathSync(fs.mkdtempSync(path.join(tempRoot,'xingzhi-grounding-live-'))),records=[];
 const traceDir=path.join(output,'calls',pair.caseId.replace(/:/g,'--'),arm);fs.mkdirSync(traceDir,{recursive:true});
 let task,a,technicalError,exception,capReached;
 try{
  a=new Assistant({dir,chat:async(provider,_key,messages,options={})=>{
   if(records.length>=armLimit){capReached='EVAL_CALL_LIMIT';throw Object.assign(Error('Per-arm evaluation call limit reached'),{code:capReached,automaticRetry:false});}
   if(report.calls.length>=limit){capReached='EVAL_GLOBAL_LIMIT';throw Object.assign(Error('Global evaluation call limit reached'),{code:capReached,automaticRetry:false});}
   const record={index:report.calls.length+1,caseId:pair.caseId,arm,role:options.role,stage:options.stage,startedAt:now(),status:'running',inputChars:messages.reduce((n,m)=>n+m.content.length,0)};
   report.calls.push(record);records.push(record);save();
   const file=path.join(traceDir,String(records.length).padStart(2,'0')+'.json');fs.writeFileSync(file,JSON.stringify({record,messages},null,2));
   try{
    const response=await subscription.chat({...provider,requestPolicy:{idleMinutes:2,totalMinutes:3}},'',messages,{...options,signal:controller.signal,timeoutMs:180000,onUsage:v=>{record.usage=v;options.onUsage?.(v);}});
    record.status='completed';record.kind=response.kind||response.tool||(typeof response.passed==='boolean'?'verification':'json');
    fs.writeFileSync(file,JSON.stringify({record,messages,response},null,2));return response;
   }catch(e){record.status='failed';record.code=e.code||'UNKNOWN';record.error=e.message;fs.writeFileSync(file,JSON.stringify({record,messages},null,2));throw e;}
   finally{record.finishedAt=now();record.durationMs=Date.now()-Date.parse(record.startedAt);save();}
  }});
  a.data.settings.evidenceGrounding=arm==='strict';a.data.settings.automatic=false;
  await a.dispatch('saveProvider',{type:'codex',name:'Isolated live evaluation',model:values.model,reasoning:values.reasoning,inputPrice:0,cachedInputPrice:0,outputPrice:0,requestPolicy:{idleMinutes:2,totalMinutes:3,retries:0}});
  // Deliberately copy only public task inputs; never spec.expected/wrongAnswer.
  a.addSources(pair.spec.sources.map(s=>({title:s.title,content:s.content})));
  task=a.createTask({title:pair.spec.title,description:pair.spec.description,criteria:pair.spec.criteria,sourceIds:a.data.sources.map(s=>s.id),generationMode:'single',steps:[{title:'生成符合指定格式的结论',kind:'draft'}]});
  if(pair.lane==='fixed'){
   const step=task.steps[0],artifact={id:crypto.randomUUID(),taskId:task.id,stepId:step.id,title:pair.spec.title,content:pair.candidate,origin:'user_import',createdAt:now()};
   a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});step.done=true;step.artifactId=artifact.id;require('../desktop/deliverables.cjs').record(a,task,step,artifact,{});
  }
  a.save();await a.dispatch('advance',{id:task.id});await a.runPromise;
 }catch(e){exception={code:e.code,message:e.message};}
 try{
  const artifact=a&&task?require('../desktop/deliverables.cjs').primary(a,task):null;
  const modelFailures=records.filter(r=>r.status==='failed');
  const delivered=!!task&&task.status==='review'&&task.verification?.passed===true;
  if(exception||capReached||(!delivered&&modelFailures.length))technicalError=exception?.code||capReached||modelFailures[0]?.code||'EVAL_RUNNER_ERROR';
  const grade=metrics.grade(pair.spec,artifact?.content);
  const row={caseId:pair.caseId,lane:pair.lane,arm,category:pair.spec.category,spec:{id:pair.spec.id,answerable:pair.spec.answerable,expected:pair.spec.expected},...(pair.lane==='fixed'?{goldCandidateCorrect:pair.goldCandidateCorrect}:{}),
   grade,delivered,taskStatus:task?.status||'error',lastError:task?.lastError||exception?.message||'',waitingOn:task?.waitingOn||'',modelFailureHistory:modelFailures.map(r=>({index:r.index,code:r.code,error:r.error})),
   candidate:artifact?.content||null,verification:task?.verification||null,grounding:task?.grounding||null,technicalError:technicalError||null,usage:totals(records),calls:records.length,durationMs:Date.now()-started};
  report.rows.push(row);save();console.log(JSON.stringify({event:'arm.completed',caseId:pair.caseId,arm,delivered:row.delivered,correct:grade.correct,hallucination:grade.hallucination,status:row.taskStatus,calls:row.calls,usage:row.usage,technicalError:row.technicalError}));
 }finally{
  if(dir.startsWith(tempRoot+path.sep)&&path.basename(dir).startsWith('xingzhi-grounding-live-'))try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
 }
}
async function main(){
 const status=await subscription.status();if(!status.loggedIn)throw Error('ChatGPT subscription is not logged in');
 if(!status.models.some(m=>m.id===values.model))throw Error('Requested model is not in local public model cache');
 report.cliVersion=status.version;report.status='running';save();let next=0;
 const worker=async()=>{while(next<plan.length){const i=next++,pair=plan[i];for(const arm of i%2?['strict','baseline']:['baseline','strict'])await runArm(pair,arm);}};
 await Promise.all(Array.from({length:report.design.concurrency},worker));report.status=report.rows.length===plan.length*2?'completed':'incomplete';report.finishedAt=now();save();
 console.log(JSON.stringify({event:'evaluation.completed',status:report.status,arms:report.rows.length,calls:report.calls.length,output}));
}
main().catch(e=>{report.status='failed';report.error={code:e.code,message:e.message};save();console.error(JSON.stringify(report.error));process.exitCode=1;});
