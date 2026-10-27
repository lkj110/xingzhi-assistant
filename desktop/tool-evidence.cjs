'use strict';
const protocol=require('./task-context.cjs'),{hash}=require('./evidence-basis.cjs'),{contextError,contextResult}=require('./model-errors.cjs');
const VERSION='deterministic-evidence-v2';
const liveObservations=new WeakMap();
// Only this module's parameter errors are correctable. A context/access/lifecycle
// failure from a reader or callback must retain its hard-failure semantics.
const parameterErrors=new WeakSet();
const fail=message=>{const error=contextError('CONTEXT_INVALID_REQUEST',{message,safeAlternatives:['仅按错误说明修正失败请求；actionId 放顶层，不猜 ID 或结果；数值运算绑定原文并明确口径。']});parameterErrors.add(error);throw error;};
const keys=(obj,allowed)=>{if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!allowed.includes(k)))fail('求证参数含不支持的字段');};
function validateRequest(request){
 keys(request,['tool','operation','inputs','args','actionId']);
 if(request.tool!=='compute_evidence'||!['sum','ratio','convert_unit','date_days','elapsed','timezone','count','file_observation','action_status'].includes(request.operation))fail('求证工具名或操作无效');
 if(['action_status','file_observation'].includes(request.operation)){
  if(typeof request.actionId!=='string'||!request.actionId.trim()||request.actionId!==request.actionId.trim())fail('状态/观察请求须使用顶层 actionId 非空字符串；不能放入 args，也不能猜测 ID');
  if(request.inputs!==undefined&&(!Array.isArray(request.inputs)||request.inputs.length))fail('状态/观察请求不接受 inputs 或自报结果');
  if(request.args!==undefined)keys(request.args,[]);
 }else{
  if(!Array.isArray(request.inputs)||request.inputs.length<1||request.inputs.length>128||request.actionId!==undefined)fail('求证输入数量须为 1–128，数值运算不能附带 actionId');
  if(request.args!==undefined&&(!request.args||typeof request.args!=='object'||Array.isArray(request.args)))fail('运算 args 必须为参数对象');
 }
 return request;
}
function decimal(text){if(!/^[+-]?\d{1,24}(?:\.\d{1,12})?$/.test(text))fail('输入须为明确的十进制数，不能含表达式或含糊单位');const [a,b='']=text.split('.');return {n:BigInt(a+b),scale:b.length};}
const power=s=>10n**BigInt(s);
function format(n,scale){const sign=n<0n?'-':'';let s=(n<0n?-n:n).toString().padStart(scale+1,'0');return sign+(scale?s.slice(0,-scale)+'.'+s.slice(-scale):s);}
function quotient(n,d,scale,rounding){if(d===0n)fail('分母不能为零');if(!Number.isInteger(scale)||scale<0||scale>12||!['half_even','half_up','truncate'].includes(rounding))fail('比率/换算须指定 scale（小数位数 0–12，不是百分比倍率）和 rounding；不猜业务精度');const negative=(n<0n)!==(d<0n);n=n<0n?-n:n;d=d<0n?-d:d;let q=n*power(scale)/d,r=n*power(scale)%d;if(rounding!=='truncate'&&(r*2n>d||r*2n===d&&(rounding==='half_up'||q%2n)))q++;return format(negative?-q:q,scale);}
const units={mm:['length',1n],cm:['length',10n],m:['length',1000n],km:['length',1000000n],mg:['mass',1n],g:['mass',1000n],kg:['mass',1000000n],mL:['volume',1n],L:['volume',1000n],ms:['time',1n],s:['time',1000n],min:['time',60000n],h:['time',3600000n]};
function csv(text){const rows=[],row=[];let value='',quoted=false,closed=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;}else if(c==='"'&&!value&&!closed)quoted=true;else if(c===','){row.push(value);value='';closed=false;}else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);rows.push([...row]);row.length=0;value='';closed=false;}else{if(closed||c==='"')fail('CSV 引号或分隔结构无效');value+=c;}}if(quoted)fail('CSV 引号未闭合');if(value||row.length||closed){row.push(value);rows.push(row);}if(!rows.length)return [];const header=rows.shift().map((v,i)=>i?v:v.replace(/^\uFEFF/,''));if(header.some(v=>!v)||new Set(header).size!==header.length||rows.some(r=>r.length!==header.length))fail('CSV 表头重复、缺失或行列不齐');return rows.map(r=>Object.fromEntries(header.map((k,i)=>[k,r[i]])));}
function input(a,task,op,spec){
 keys(spec,['sourceId','start','end','whole','unit']);if(typeof spec.sourceId!=='string')fail('求证输入须绑定来源 ID');
 let body,version,policyRevision,source;
 if(spec.sourceId.startsWith('user:')){
  const field=spec.sourceId.slice(5),record=(task.groundingUserInputs||[]).find(r=>r.origin==='user'&&r.field===field&&r.text===task[field]);if(!record)fail('用户数字缺少可回查的原始输入');body=record.text;version=hash(body);policyRevision='user-statement';
 }else{
  source=op.context().readableCatalog.find(s=>s.id===spec.sourceId&&s.type==='source'&&s.purpose==='input'&&!s.ambiguous);if(!source)throw contextError('CONTEXT_SCOPE_DENIED');
  const read=op.resolveRead({tool:'read_source',sourceId:source.id,version:source.version,limit:1});if(!read.ok)throw contextError(read.code,read);
  body=op.snapshot().readContent(source.id);version=source.version;policyRevision=source.policyRevision;
 }
 let value,start=spec.start,end=spec.end;
 if(spec.whole===true){if(start!==undefined||end!==undefined)fail('整表输入不能同时指定局部范围');value=body;start=0;end=body.length;
  const original=source&&op.source(source.id);if(original?.segments?.length&&original.segments.every(s=>s.structure==='raw-contiguous'))value=original.segments.map(s=>s.text).join('');
 }else{if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>body.length||end-start>2000)fail('数字/日期参数须指定当前原文的精确 start/end');value=body.slice(start,end);}
 return {sourceId:spec.sourceId,version,policyRevision,start,end,whole:spec.whole===true,unit:spec.unit??null,value,inputHash:hash(value)};
}
function calculate(operation,args,inputs){
 const texts=inputs.map(i=>i.value.trim());
 if(operation==='sum'){
  keys(args,['unit']);if(!texts.length||inputs.some(i=>i.whole)||typeof args.unit!=='string'||inputs.some(i=>i.unit!==args.unit))fail('合计须明确且统一每项单位');
  const values=texts.map(decimal),scale=Math.max(...values.map(v=>v.scale));return {value:format(values.reduce((n,v)=>n+v.n*power(scale-v.scale),0n),scale),unit:args.unit};
 }
 if(operation==='ratio'){
  keys(args,['scale','rounding']);if(texts.length!==2||inputs.some(i=>i.whole)||inputs[0].unit!==inputs[1].unit||!inputs[0].unit)fail('比率需两个同单位输入和明确分母');const [a,b]=texts.map(decimal);return {value:quotient(a.n*power(b.scale),b.n*power(a.scale),args.scale,args.rounding),unit:'ratio'};
 }
 if(operation==='convert_unit'){
  keys(args,['to','scale','rounding']);if(texts.length!==1||inputs[0].whole)fail('单位换算仅接受一个绑定的数值');const from=units[inputs[0].unit],to=units[args.to];if(!from||!to||from[0]!==to[0])fail('不支持或不兼容的单位，不能猜换算关系');const v=decimal(texts[0]);return {value:quotient(v.n*from[1],power(v.scale)*to[1],args.scale,args.rounding),unit:args.to};
 }
 if(operation==='date_days'){
  keys(args,[]);if(texts.length!==2||inputs.some(i=>i.whole))fail('日期间隔需两个完整日期');const times=texts.map(s=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))fail('日期须为 YYYY-MM-DD；不支持未指定的工作日规则');const n=Date.parse(s+'T00:00:00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==s)fail('无效日期');return n;});return {value:String((times[1]-times[0])/86400000),unit:'calendar_days',boundary:'end minus start'};
 }
 if(operation==='elapsed' || operation==='timezone'){
  keys(args,operation==='elapsed'?['timeZone','unit']:['timeZone']);if(typeof args.timeZone!=='string')fail('必须指定 IANA 时区');try{new Intl.DateTimeFormat('en',{timeZone:args.timeZone});}catch{fail('无效时区');}
  if(texts.length!==(operation==='elapsed'?2:1)||texts.some(s=>{const m=s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/);return !m||!Number.isFinite(Date.parse(s))||new Date(Date.parse(m[1]+'T00:00:00Z')).toISOString().slice(0,10)!==m[1]||+m[2]>23||+m[3]>59||+m[4]>59||m[5]!=='Z'&&(+m[7]>14||+m[8]>59||+m[7]===14&&+m[8]!==0);}))fail('时间必须为有效公历日期且包含明确 UTC 偏移，拒绝夏令时重复/缺失的本地时刻');
  if(operation==='timezone')return {value:new Intl.DateTimeFormat('sv-SE',{timeZone:args.timeZone,dateStyle:'short',timeStyle:'long',hour12:false}).format(new Date(texts[0])),unit:args.timeZone};
  if(!['ms','s','min','h'].includes(args.unit))fail('时间差单位须为 ms/s/min/h');return {value:quotient(BigInt(Date.parse(texts[1])-Date.parse(texts[0])),units[args.unit][1],6,'half_even'),unit:args.unit,timeZone:args.timeZone};
 }
 if(operation==='count'){
  keys(args,['format','filter']);if(!inputs[0]?.whole||!['csv','json'].includes(args.format)||inputs.length>2)fail('计数须读取完整 CSV/JSON 表，不能数局部摘录');let rows;if(args.format==='csv')rows=csv(inputs[0].value);else{try{rows=JSON.parse(inputs[0].value);}catch{fail('JSON 结构无效');}if(!Array.isArray(rows))fail('JSON 计数只支持顶层数组');}
  if(args.filter){keys(args.filter,['column','op','inputIndex']);const f=args.filter;if(!['eq','ne','lt','lte','gt','gte','contains'].includes(f.op)||typeof f.column!=='string'||f.inputIndex!==1||!inputs[1]||inputs[1].whole)fail('过滤须指定列、白名单运算符及绑定原文的第二输入');const v=texts[1];rows=rows.filter(row=>{if(!row||typeof row!=='object'||!Object.hasOwn(row,f.column))fail('过滤字段不存在');const x=String(row[f.column]);if(f.op==='eq')return x===v;if(f.op==='ne')return x!==v;if(f.op==='contains')return x.includes(v);const a=decimal(x),b=decimal(v),left=a.n*power(b.scale),right=b.n*power(a.scale);return f.op==='lt'?left<right:f.op==='lte'?left<=right:f.op==='gt'?left>right:left>=right;});}
  return {value:String(rows.length),unit:'rows',headerExcluded:args.format==='csv'};
 }
 fail('不支持的求证操作');
}
function evaluate(a,task,request){
 validateRequest(request);
 if(request.operation==='file_observation'){
  if(request.inputs?.length||request.args&&Object.keys(request.args).length)fail('文件观察不能包含自报结果');
  return require('./file-observation.cjs').observe(a,task,request);
 }
 if(request.operation==='action_status'){
  if(request.inputs?.length||request.args&&Object.keys(request.args).length)fail('状态查询不能包含自报结果');const record=a.data.agentActions.find(r=>r.id===request.actionId&&r.taskId===task.id&&r.jobId===task.agentJobId);if(!record)throw contextError('CONTEXT_SCOPE_DENIED');
  const observation=require('./revision-protocol.cjs').deliveryContext(a,task,record,protocol.buildContext(a,protocol.taskScope(task),'verify'));
  const result=observation.result||{};
  const local=require('./agent-local.cjs').actions.includes(record.tool),live=liveObservations.get(a)?.get(record.id);
  const fileObservation=require('./file-observation.cjs'),identity=record.tool==='write_file'?fileObservation.identity(a,task,request):null;
  const files=identity?require('./agent-writes.cjs').observeRecordedFile(a,identity.job,task,record):null;
  if(identity&&fileObservation.identity(a,task,request).basis!==identity.basis)throw contextError('CONTEXT_VERSION_CHANGED');
  const fresh=local||!!files||live&&Date.now()-live.at<60000&&live.recordHash===hash(record),observedHash=files?hash(files):local?hash(observation):fresh?live.actualHash:null;
  const matched=files?.every(f=>f.exists&&f.contentMatches),fileStatus=files?.some(f=>!f.exists)?'file_missing':matched?'readback_verified':'content_mismatch';
  return {inputs:[],basis:hash([record,observation,!!fresh,observedHash]),...(identity?{observationBasis:identity.basis}:{}),output:{status:files?fileStatus:observation.current===true&&record.status==='done'?(result.status==='accepted'?'accepted_only':result.verified===true&&fresh?'readback_verified':'unknown'):'unknown',actionId:record.id,tool:record.tool,readbackHash:observedHash,...(files?{deliveryCurrent:observation.current===true,readbackHashKind:'file_comparison_observation',comparison:matched?'matches_recorded_content':fileStatus==='file_missing'?'file_missing':'differs_from_recorded_content',files}:{}),note:files?'App 本次只读回查：存在的文件已逐字比较完整正文，缺失文件明确标记。files 给出原/现正文哈希、一致性和有界摘录，观察时间见 observedAt。仅证明该时点与记录版本的本地比较，不证明当前主稿已交付，也不证明对外发送、送达或收件。':'仅证明该观察时点的回执/回读，受理不证明收件或部署完成；没有新鲜回读时状态未知'},dynamic:true};
 }
 if(!Array.isArray(request.inputs)||request.inputs.length<1||request.inputs.length>128||request.actionId!==undefined)fail('求证输入数量须为 1–128');
 return protocol.withContext(a,protocol.taskScope(task),op=>{const inputs=request.inputs.map(r=>input(a,task,op,r));return {inputs:inputs.map(({value,...r})=>r),basis:hash(inputs),output:calculate(request.operation,request.args||{},inputs),dynamic:false};});
}
const baseOutput=r=>r.temporalScope==='observed_at'||r.observationBasis?Object.fromEntries(Object.entries(r.output).filter(([k])=>!['observedAt','temporalScope'].includes(k))):r.output;
function execute(a,task,request){
 const value=evaluate(a,task,request);
 const prior=(task.toolEvidence||[]).find(r=>r.version===VERSION&&hash(r.request)===hash(request)&&r.contentHash===hash({...r,contentHash:undefined})&&(!r.validUntil||Date.parse(r.validUntil)>Date.now())&&r.basis===value.basis&&r.observationBasis===value.observationBasis&&(r.temporalScope!=='observed_at'||valid(a,task,r))&&hash(baseOutput(r))===hash(value.output));
 if(prior){require('./tool-execution-events.cjs').record(task,prior,true);return prior;}
 const observedAt=new Date().toISOString(),receipt={version:VERSION,request:structuredClone(request),...value,observedAt,validUntil:value.dynamic?new Date(Date.now()+60000).toISOString():null};
 if(value.temporalScope==='observed_at')receipt.output={...receipt.output,observedAt,temporalScope:'observed_at'};
 else if(value.observationBasis)receipt.output={...receipt.output,observedAt};
 receipt.resultText=JSON.stringify(receipt.output);receipt.id='tool:'+hash(receipt).slice(0,24);receipt.contentHash=hash(receipt);
 task.toolEvidence=[...(task.toolEvidence||[]).filter(r=>hash(r.request)!==hash(request)),receipt].slice(-64);require('./tool-execution-events.cjs').record(task,receipt,false);return receipt;
}
function valid(a,task,receipt){try{if(receipt.version!==VERSION||receipt.contentHash!==hash({...receipt,contentHash:undefined})||receipt.validUntil&&Date.parse(receipt.validUntil)<=Date.now())return false;
 if(receipt.request.operation==='file_observation')return require('./file-observation.cjs').valid(a,task,receipt);
 const current=evaluate(a,task,receipt.request);return current.basis===receipt.basis&&hash(current.output)===hash(baseOutput(receipt));}catch{return false;}}
function current(a,task){if(!require('./context-optimizations.cjs').enabled(a,'C'))return [];return (task.toolEvidence||[]).filter(r=>valid(a,task,r));}
function observationValid(a,task,receipt){try{return receipt.version===VERSION&&receipt.contentHash===hash({...receipt,contentHash:undefined})&&require('./file-observation.cjs').validStatus(a,task,receipt);}catch{return false;}}
// Readable historical evidence is not fresh evidence for current delivery or
// evidence-resume progress. Those callers deliberately retain current().
function readable(a,task){if(!require('./context-optimizations.cjs').enabled(a,'C'))return [];return (task.toolEvidence||[]).filter(r=>valid(a,task,r)||observationValid(a,task,r));}
function project(receipt,task){const executions=task?.id?require('./tool-execution-events.cjs').project(task,receipt):null;return {id:receipt.id,version:receipt.version,operation:receipt.request.operation,parameters:receipt.request.args||{},inputs:receipt.inputs,output:receipt.output,resultText:receipt.resultText+(executions?'\n显式求值记录：'+JSON.stringify({retainedCount:executions.retainedCount,events:executions.events,omitted:executions.omitted}):''),contentHash:receipt.contentHash,progressKey:hash([receipt.version,receipt.request,receipt.basis,receipt.output]),observedAt:receipt.observedAt,validUntil:receipt.validUntil,...(receipt.observationBasis?{historicalObservation:true}:{}),...(receipt.temporalScope?{temporalScope:receipt.temporalScope}:{}),...(executions?{executions}:{})};}
function progress(state,receipt,visible){
 state.toolCoverage ||= {};const key=receipt?.progressKey;if(!key)return 'failed';
 if(!state.toolCoverage[key]&&Object.keys(state.toolCoverage).length<256){state.toolCoverage[key]={restored:false};return 'fresh';}
 if(state.toolCoverage[key]&&!state.toolCoverage[key].restored&&!(visible.toolEvidence||[]).some(r=>r.progressKey===key)){state.toolCoverage[key].restored=true;return 'restored';}
 return 'duplicate';
}
async function refreshStatus(a,task,request){
 validateRequest(request);
 if(request.operation!=='action_status')return;
 const record=a.data.agentActions.find(r=>r.id===request.actionId&&r.taskId===task.id&&r.jobId===task.agentJobId),job=a.data.delegations.find(j=>j.id===task.agentJobId&&!j.deletedAt);
 if(!record||!job)throw contextError('CONTEXT_SCOPE_DENIED');
 let observations=liveObservations.get(a);if(!observations){observations=new Map();liveObservations.set(a,observations);}observations.delete(record.id);
 if(!['write_file','github_create','github_update','github_comment','lark_create','lark_update'].includes(record.tool))return;
 require('./execution-gate.cjs').assert(a,{task,job,readOnly:true});
 const before=protocol.buildContext(a,protocol.taskScope(task),'verify');
 const writes=require('./agent-writes.cjs'),actual=record.tool==='write_file'?writes.observeRecordedFile(a,job,task,record):await writes.readRecordedDelivery(a,job,task,record);
 require('./execution-gate.cjs').assert(a,{task,job,readOnly:true});protocol.assertCurrent(a,protocol.taskScope(task),before,{delivery:true});
 if(!a.data.agentActions.includes(record)||record.status!=='done')throw contextError('CONTEXT_VERSION_CHANGED');
 observations.set(record.id,{recordHash:hash(record),actualHash:hash(actual),at:Date.now()});
}
async function refreshForDelivery(a,task){
 if(!require('./context-optimizations.cjs').enabled(a,'C'))return;
 const ids=new Set((task.grounding?.claims||[]).flatMap(c=>(c.citations||[]).filter(q=>q.evidenceType==='tool'&&q.temporalScope!=='observed_at').map(q=>q.sourceId)));
 for(const receipt of task.toolEvidence||[])if(ids.has(receipt.id)&&receipt.dynamic)await refreshStatus(a,task,receipt.request);
}
async function readRequests(a,task,requests,next){
 if(!Array.isArray(requests)||requests.length<1||requests.length>4)return next(requests);
 const normal=[],receipts=[],computedRows=[];for(const r of requests)if(r?.tool==='compute_evidence'){
  try{validateRequest(r);await refreshStatus(a,task,r);const receipt=project(execute(a,task,r),task);receipts.push(receipt);computedRows.push({request:structuredClone(r),result:{ok:true,computedEvidence:receipt,complete:true}});}
  catch(error){if(!parameterErrors.has(error))throw error;computedRows.push({request:structuredClone(r),result:contextResult(error)});}
 }else normal.push(r);
 const batch=normal.length?await next(normal):{rows:[],pageRows:[],used:[],complete:true,stats:{characters:0}};
 if(receipts.length){a.save();batch.toolEvidence=receipts;}
 batch.rows.push(...computedRows);batch.complete=batch.rows.length>0&&batch.rows.every(row=>row.result.ok&&row.result.complete);
 return batch;
}
const instruction=require('./claim-observation.cjs').instruction+'\n'+'executions.events 给出显式求值事件（同一结果 ID 可有多次实际求值）；内部校验复算不计为执行，也不代表多个业务来源。\n白名单求证：read_context.requests:[{tool:"compute_evidence",operation:"sum|ratio|convert_unit|date_days|elapsed|timezone|count|file_observation|action_status",inputs:[{sourceId,start,end,unit}],args:{}}]。业务数值/日期须绑定当前原文位置，用户原始陈述可用 userInputs ID；不能传裸数或脚本。sum 的 args.unit 须与每个输入一致；ratio 两个同单位输入（顺序为分子/分母）及 args:{scale,rounding:"half_even|half_up|truncate"}；scale 是 0–12 的小数位数，不是百分比倍率，输出为比例值；分母和业务精度必须明确，不默认猜测。convert_unit 加 to（mm/cm/m/km、mg/g/kg、mL/L、ms/s/min/h）。date_days 两个 YYYY-MM-DD 计算末减初；elapsed/timezone 输入含 UTC 偏移，args.timeZone 为 IANA，elapsed 加 unit。count 输入 whole:true，args.format:"csv|json"；可选 filter:{column,op:"eq|ne|lt|lte|gt|gte|contains",inputIndex:1}，第二输入绑定筛选值。file_observation 用 actionId 对历史 write_file 做完整比较，保留 observedAt 时点证据，不能支持“现在仍一致”；文件现在的状态或交付必须用 action_status 新鲜回读。action_status 用顶层 actionId 不带 inputs；当前状态 60 秒后失效，historicalObservation 仍仅证明 observedAt 时点的文件比较。toolEvidence 是 App 计算回执，仅证明对应运算/观察，不证明原始业务数据真实；核验引文 sourceId 用回执 id，quote 用 resultText，仍核对原始口径。';
function verificationInstruction({structured=false,final=false}={}){
 const meaning=require('./claim-observation.cjs').instruction+'\n'+'executions.events给出显式求值事件，同一结果ID可有多次实际求值；内部复算不算执行或多个业务来源。file_observation只证明observedAt时点的历史比较，不能支持“现在仍一致”或“已交付”；action_status的historicalObservation只保留文件观察时点事实；当前状态及交付仍需新鲜回读（60秒后失效）及交付证据。toolEvidence仅证明对应运算/观察，不证明业务原始数据真实；引文sourceId用回执id，quote用resultText，仍核对原始口径。';
 if(final)return '\n'+meaning+'核对运算口径：业务数值/日期必须绑定当前原文位置，不能以裸数作证；sum所有输入及结果同单位；ratio依次为分子/分母，输入同单位，scale是0–12小数位而非百分比倍率，结果是比例，精度与舍入不得猜测。单位转换须核对原单位和目标单位；date_days为末日减初日；elapsed/timezone输入有UTC偏移，timeZone为IANA，elapsed核对unit。count须完整输入，筛选值来自第二个绑定输入。';
 if(!structured)return instruction;
 return '\n'+meaning+'可在read_context请求compute_evidence。业务数值/日期须绑定当前原文位置，用户原始陈述可用userInputs ID，不能传裸数或脚本。sum的args.unit须与每个输入一致；ratio须两个同单位输入，依次为分子/分母；scale为0–12小数位数，输出比例值，不是百分比倍率，分母、rounding和业务精度须明确，不默认猜测。convert_unit的to支持mm/cm/m/km、mg/g/kg、mL/L、ms/s/min/h。date_days用两个YYYY-MM-DD计算末减初；elapsed/timezone输入含UTC偏移，timeZone为IANA，elapsed另带unit。count输入须whole:true，format指明csv或json；filter的column/op指定列及比较方式，inputIndex:1将第二输入绑定为筛选值。file_observation用actionId对历史write_file完整比较；action_status用actionId且不带inputs。';
}
const plannerInstruction=instruction.replace('read_context.requests:[{tool:"compute_evidence",operation:','{tool:"compute_evidence",args:{taskId,operation:').replace('args:{}}]。','args:{}}}。');
module.exports={plannerInstruction,VERSION,execute,validateRequest,valid,current,readable,observationValid,project,readRequests,instruction,verificationInstruction,calculate,csv,refreshStatus,refreshForDelivery,progress};
