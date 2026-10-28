'use strict';
// Independent content review is an external checkpoint, never a model reply or
// a write to product state. A caller must keep one absolute round deadline.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const failure=(code,message,extra={})=>Object.assign(Error(message),{code,...extra});
function check(condition,code,message){if(!condition)throw failure(code,message);}
function abortError(){return failure('CHECKPOINT_CANCELLED','Independent review wait was cancelled');}
function delay(ms,signal){return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(abortError());return;}
 const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
 const timer=setTimeout(finish,ms),abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(abortError());};
 signal?.addEventListener('abort',abort,{once:true});
});}
function projection(input,draft){
 check(object(input)&&object(draft),'CHECKPOINT_INPUT','Business input and current draft are required');
 for(const key of ['title','description','criteria'])check(text(input[key]),'CHECKPOINT_INPUT','Missing business '+key);
 check(Array.isArray(input.sources)&&input.sources.length>0,'CHECKPOINT_INPUT','Original sources are required');
 const sources=input.sources.map(source=>{check(object(source)&&text(source.title)&&text(source.content),'CHECKPOINT_INPUT','Each source needs title and original content');return {title:source.title,content:source.content};});
 check(text(draft.title)&&text(draft.content),'CHECKPOINT_INPUT','Current draft title and content are required');
 return {input:{title:input.title,description:input.description,criteria:input.criteria,sources},draft:{title:draft.title,content:draft.content}};
}
function createCheckpoint({directory,caseId,stage,input,draft,sealIdentity,now=Date.now,delay:pause=delay}){
 check(typeof directory==='string'&&path.isAbsolute(directory),'CHECKPOINT_INPUT','Checkpoint directory must be absolute');
 for(const value of [caseId,stage])check(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(value),'CHECKPOINT_INPUT','Invalid checkpoint case or stage');
 check(typeof sealIdentity==='string'&&/^[a-f0-9]{64}$/.test(sealIdentity),'CHECKPOINT_INPUT','A sealed suite identity is required');
 check(typeof now==='function'&&typeof pause==='function','CHECKPOINT_INPUT','Invalid clock or delay');
 const content=projection(input,draft),request={schema:1,checkpointId:crypto.randomUUID(),caseId,stage,sealIdentity,...content,contentSha256:hash(content)};
 request.identity=hash(request);
 fs.mkdirSync(directory,{recursive:true});const base=fs.realpathSync(directory),dir=path.join(base,caseId+'--'+stage);
 try{fs.mkdirSync(dir);}catch(error){if(error.code==='EEXIST')throw failure('CHECKPOINT_EXISTS','This case/stage checkpoint already exists; it cannot be silently replaced');throw error;}
 const requestPath=path.join(dir,'request.json'),decisionPath=path.join(dir,'decision.json');
 const requestText=JSON.stringify(request,null,2)+'\n';
 fs.writeFileSync(requestPath,requestText,{flag:'wx',mode:0o600});let boundDeadline;
 // The independent reviewer writes decision.json to a sibling temporary file
 // and renames it atomically. A missing/truncated file is never an approval.
 function readDecision(){
  let before,raw,after;
  try{
   before=fs.lstatSync(decisionPath);check(before.isFile()&&!before.isSymbolicLink(),'CHECKPOINT_DECISION','Review decision must be a regular file');
   check(before.size<=65536,'CHECKPOINT_DECISION','Review decision is too large');
   raw=fs.readFileSync(decisionPath,'utf8');after=fs.lstatSync(decisionPath);
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs)return null;
  let value;try{value=JSON.parse(raw);}catch(error){if(error instanceof SyntaxError)return null;throw error;}
  check(object(value),'CHECKPOINT_DECISION','Review decision must be an object');
  check(value.schema===1&&value.caseId===caseId&&value.stage===stage&&value.identity===request.identity&&value.sealIdentity===sealIdentity&&value.reviewer==='independent-subagent','CHECKPOINT_IDENTITY','Review decision is not bound to this independent content checkpoint');
  check(typeof value.approved==='boolean'&&text(value.verdict),'CHECKPOINT_DECISION','Review must explicitly approve or reject with a reason');
  return value;
 }
 async function wait({signal,deadline}={}){
  check(Number.isFinite(deadline),'CHECKPOINT_DEADLINE','Pass the original absolute round deadline');
  if(boundDeadline===undefined)boundDeadline=deadline;
  check(boundDeadline===deadline,'CHECKPOINT_DEADLINE_CHANGED','The review deadline cannot be reset');
  let previous=now();check(Number.isFinite(previous),'CHECKPOINT_CLOCK','Clock is invalid');
  function guard(){
   if(signal?.aborted)throw abortError();
   const current=now();check(Number.isFinite(current)&&current>=previous,'CHECKPOINT_CLOCK','Clock moved backwards or became invalid');previous=current;
   if(current>=deadline)throw failure('CHECKPOINT_EXPIRED','Independent content review did not finish before the round deadline');
   check(fs.readFileSync(requestPath,'utf8')===requestText,'CHECKPOINT_REQUEST_CHANGED','The sealed review input changed while awaiting independent review');return current;
  }
  for(;;){
   guard();const decision=readDecision();const current=guard();
   if(decision){if(!decision.approved)throw failure('CHECKPOINT_REJECTED','Independent content review rejected this draft',{verdict:decision.verdict,decision});return decision;}
   await pause(Math.min(100,deadline-current),signal);
  }
 }
 return {requestPath,decisionPath,identity:request.identity,wait};
}
module.exports={createCheckpoint};
