'use strict';
// Both conditions use strict grounding. Only the frozen grounding module differs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {parseArgs}=require('node:util');
const metrics=require('./grounding-eval-metrics.cjs'),subscription=require('../desktop/subscription.cjs');
const {e2eCases,fixedCases}=require('./grounding-v3-eval-cases.cjs');
const {values}=parseArgs({options:{model:{type:'string',default:'gpt-6.1-sol'},reasoning:{type:'string',default:'medium'},out:{type:'string'},'baseline-root':{type:'string'},'candidate-root':{type:'string'},'max-calls':{type:'string',default:'90'},'arm-calls':{type:'string',default:'6'},concurrency:{type:'string',default:'2'},lane:{type:'string',default:'all'}}});
for(const key of ['out','baseline-root','candidate-root'])if(!values[key])throw Error('Missing --'+key);
const roots={baseline:path.resolve(values['baseline-root']),strict:path.resolve(values['candidate-root'])};
const classes=Object.fromEntries(Object.entries(roots).map(([arm,root])=>[arm,require(path.join(root,'desktop/core.cjs')).Assistant]));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),hash=value=>sha(JSON.stringify(value)),now=()=>new Date().toISOString();
function files(root){const found=[];function visit(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())visit(file);else if(name.endsWith('.cjs'))found.push([path.relative(root,file).replace(/\\/g,'/'),sha(fs.readFileSync(file))]);}}visit(path.join(root,'desktop'));return found;}
const implementations=Object.fromEntries(Object.entries(roots).map(([arm,root])=>[arm,{root,files:files(root),groundingVersion:require(path.join(root,'desktop/grounding.cjs')).VERSION}]));
const differences=implementations.baseline.files.filter(([name,digest])=>implementations.strict.files.find(([other])=>other===name)?.[1]!==digest).map(([name])=>name);
if(differences.length!==1||differences[0]!=='desktop/grounding.cjs'||implementations.baseline.files.length!==implementations.strict.files.length)throw Error('Frozen implementations must differ only in desktop/grounding.cjs');
if(!['all','fixed','e2e'].includes(values.lane))throw Error('Unknown lane');
const plan=[...e2eCases.map(spec=>({caseId:'e2e:'+spec.id,lane:'e2e',spec,expectedDelivered:true})),...fixedCases.map(spec=>({caseId:'fixed:'+spec.id,lane:'fixed',spec,candidate:spec.candidate,expectedDelivered:spec.expectedDelivered}))].filter(pair=>values.lane==='all'||pair.lane===values.lane);
const limit=Number(values['max-calls']),armLimit=Number(values['arm-calls']),concurrency=Math.min(2,Math.max(1,Number(values.concurrency)||1));
if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(armLimit)||armLimit<1)throw Error('Invalid budget');
const sharedRoot=path.resolve(__dirname,'..'),sharedImplementation={adapter:require.resolve('../desktop/subscription.cjs'),files:files(sharedRoot),scorer:sha(fs.readFileSync(path.join(__dirname,'grounding-eval-metrics.cjs'))),cases:sha(fs.readFileSync(path.join(__dirname,'grounding-v3-eval-cases.cjs')))};
const output=path.resolve(values.out),identity=hash({plan,implementations,sharedImplementation,model:values.model,reasoning:values.reasoning,limit,armLimit,concurrency,runner:sha(fs.readFileSync(__filename))});
fs.mkdirSync(output,{recursive:true});const reportPath=path.join(output,'report.json');
const report=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath,'utf8')):{schema:1,identity,model:values.model,reasoning:values.reasoning,startedAt:now(),syntheticOnly:true,liveExternalActions:false,implementations,sharedImplementation,
 design:{pairs:plan.length,e2ePairs:plan.filter(p=>p.lane==='e2e').length,fixedCandidatePairs:plan.filter(p=>p.lane==='fixed').length,conditions:{baseline:'strict grounding v2',strict:'strict grounding v3'},strictEnabledBoth:true,onlyImplementationDifference:differences,concurrency,order:'alternating version first',maxCalls:limit,armCallLimit:armLimit,deliveryMeaning:'production result verification passed; no external publication'},rows:[],calls:[]};
if(report.identity!==identity)throw Error('Immutable plan or implementation mismatch');
const save=()=>{report.updatedAt=now();fs.writeFileSync(reportPath,JSON.stringify(report,null,2));};
const controller=new AbortController();process.on('SIGINT',()=>controller.abort());process.on('SIGTERM',()=>controller.abort());
async function run(pair,arm){
 if(report.rows.some(r=>r.caseId===pair.caseId&&r.arm===arm))return;
 controller.signal.throwIfAborted();const started=Date.now(),tmp=fs.realpathSync(os.tmpdir()),dir=fs.realpathSync(fs.mkdtempSync(path.join(tmp,'xingzhi-grounding-v3-'))),records=[];
 const trace=path.join(output,'calls',pair.caseId.replace(/:/g,'--'),arm);fs.mkdirSync(trace,{recursive:true});
 let a,task,exception,capReached;
 try{
  a=new classes[arm]({dir,chat:async(provider,key,messages,options={})=>{
   if(provider.model!==values.model||provider.reasoning!==values.reasoning)throw Object.assign(Error('Unexpected model routing in isolated evaluation'),{code:'EVAL_MODEL_MISMATCH'});
   if(records.length>=armLimit||report.calls.length>=limit){capReached=records.length>=armLimit?'EVAL_CALL_LIMIT':'EVAL_GLOBAL_LIMIT';throw Object.assign(Error(capReached),{code:capReached,automaticRetry:false});}
   const record={index:report.calls.length+1,caseId:pair.caseId,arm,model:provider.model,reasoning:provider.reasoning,role:options.role,stage:options.stage,startedAt:now(),status:'running',inputChars:messages.reduce((n,m)=>n+m.content.length,0)};
   records.push(record);report.calls.push(record);save();const file=path.join(trace,String(records.length).padStart(2,'0')+'.json');fs.writeFileSync(file,JSON.stringify({record,messages},null,2));
   try{const response=await subscription.chat({...provider,requestPolicy:{idleMinutes:2,totalMinutes:3}},'',messages,{...options,signal:controller.signal,timeoutMs:180000,onUsage:v=>{record.usage=v;options.onUsage?.(v);}});record.status='completed';record.kind=response.kind||response.tool||(typeof response.passed==='boolean'?'verification':'json');fs.writeFileSync(file,JSON.stringify({record,messages,response},null,2));return response;}
   catch(e){record.status='failed';record.code=e.code||'UNKNOWN';record.error=e.message;fs.writeFileSync(file,JSON.stringify({record,messages},null,2));throw e;}
   finally{record.finishedAt=now();record.durationMs=Date.now()-Date.parse(record.startedAt);save();}
  }});
  a.data.settings.evidenceGrounding=true;a.data.settings.automatic=false;
  await a.dispatch('saveProvider',{type:'codex',name:'Isolated strict version evaluation',model:values.model,reasoning:values.reasoning,inputPrice:0,cachedInputPrice:0,outputPrice:0,requestPolicy:{idleMinutes:2,totalMinutes:3,retries:0}});
  // Deliberate allowlist: gold/expectedDelivered/keyAssertions never reach messages.
  a.addSources(pair.spec.sources.map(s=>({title:s.title,content:s.content})));
  task=a.createTask({title:pair.spec.title,description:pair.spec.description,criteria:pair.spec.criteria,sourceIds:a.data.sources.map(s=>s.id),generationMode:'single',steps:[{title:'生成符合指定格式的结论',kind:'draft'}]});
  if(pair.lane==='fixed'){
   const step=task.steps[0],artifact={id:crypto.randomUUID(),taskId:task.id,stepId:step.id,title:pair.spec.title,content:pair.candidate,origin:'user_import',createdAt:now()};a.data.artifacts.push(artifact);
   require(path.join(roots[arm],'desktop/protocol-access.cjs')).retain(a,'artifact',artifact,{task});step.done=true;step.artifactId=artifact.id;require(path.join(roots[arm],'desktop/deliverables.cjs')).record(a,task,step,artifact,{});
  }
  a.save();await a.dispatch('advance',{id:task.id});await a.runPromise;
 }catch(e){exception={code:e.code,message:e.message};}
 try{
  const artifact=a&&task?require(path.join(roots[arm],'desktop/deliverables.cjs')).primary(a,task):null,delivered=!!task&&task.status==='review'&&task.verification?.passed===true;
  const failures=records.filter(r=>r.status==='failed'),technicalError=exception?(exception.code||'EVAL_RUNNER_ERROR'):capReached||(!delivered&&failures[0]?.code)||null;
  const usage=Object.fromEntries(['inputTokens','outputTokens','cachedInputTokens'].map(k=>[k,records.every(r=>Number.isFinite(r.usage?.[k]))?records.reduce((n,r)=>n+r.usage[k],0):null]));
  const row={caseId:pair.caseId,lane:pair.lane,arm,category:pair.spec.category||pair.spec.qualityCategory,spec:{id:pair.spec.id,answerable:pair.spec.answerable,expected:pair.spec.expected},expectedDelivered:pair.expectedDelivered,
   ...(pair.lane==='fixed'?{candidateMeetsCriteria:pair.spec.candidateMeetsCriteria,goldCandidateCorrect:metrics.grade(pair.spec,pair.candidate).correct,expectedReason:pair.spec.expectedReason}:{}),
   grade:metrics.grade(pair.spec,artifact?.content),delivered,taskStatus:task?.status||'error',lastError:task?.lastError||exception?.message||'',candidate:artifact?.content||null,verification:task?.verification||null,grounding:task?.grounding||null,technicalError,usage,calls:records.length,durationMs:Date.now()-started};
  report.rows.push(row);save();console.log(JSON.stringify({event:'arm.completed',caseId:pair.caseId,arm,delivered,correct:row.grade.correct,calls:row.calls,technicalError}));
 }finally{if(dir.startsWith(tmp+path.sep)&&path.basename(dir).startsWith('xingzhi-grounding-v3-'))fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
async function main(){
 const status=await subscription.status();if(!status.loggedIn||!status.models.some(m=>m.id===values.model))throw Error('Requested subscription model is unavailable');report.cliVersion=status.version;report.status='running';save();
 let next=0;const worker=async()=>{while(next<plan.length){const index=next++,pair=plan[index];for(const arm of index%2?['strict','baseline']:['baseline','strict'])await run(pair,arm);}};
 await Promise.all(Array.from({length:concurrency},worker));
 const intact=Object.entries(roots).every(([arm,root])=>JSON.stringify(files(root))===JSON.stringify(implementations[arm].files))&&JSON.stringify(files(sharedRoot))===JSON.stringify(sharedImplementation.files);report.implementationUnchanged=intact;report.status=intact&&report.rows.length===plan.length*2?'completed':'incomplete';report.finishedAt=now();save();console.log(JSON.stringify({event:'evaluation.completed',status:report.status,arms:report.rows.length,calls:report.calls.length}));
}
main().catch(e=>{report.status='failed';report.error={code:e.code,message:e.message};save();console.error(e.message);process.exitCode=1;});
