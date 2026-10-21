// Remote effects are facts even when their workspace projection becomes stale.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
function atomic(file,value){
 const temp=file+'.'+crypto.randomUUID()+'.tmp';let renamed=false;
 try{
  const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);renamed=true;require('./filesystem-platform.cjs').syncDirectory(path.dirname(file));
 }catch(error){if(renamed)error.committed=true;throw error;}finally{if(!renamed)try{fs.unlinkSync(temp);}catch{}}
}
function load(a){
 if(!a.dir)return a.actionFacts||={version:1,events:[]};
 const file=path.join(a.dir,'action-facts.json');
 const sentinel=path.join(a.dir,'action-facts.initialized');
 if(!fs.existsSync(file)){
  if(fs.existsSync(sentinel))throw Error('动作事实记录缺失，不能依据旧工作空间重新执行外部写入');
  atomic(file,{version:1,events:[],checksum:hash(JSON.stringify([]))});
 }
 if(!fs.existsSync(sentinel))atomic(sentinel,{version:1});
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 if(saved.version!==1||!Array.isArray(saved.events)||saved.checksum!==hash(JSON.stringify(saved.events)))throw Error('动作事实记录校验失败，须先恢复记录，不能重新执行外部写入');
 let prior=null;for(const [i,row]of saved.events.entries())if(row.sequence!==i+1||row.previousEventId!==prior)throw Error('动作事实记录顺序异常');else prior=row.eventId;
 return saved;
}
function append(a,record,kind,detail={}){
 const store=load(a),old=store.events.findLast(e=>e.actionId===record.id),value=clone(detail);
 if(old?.kind===kind&&JSON.stringify(old.detail)===JSON.stringify(value))return old;
 const {content,baseline,...metadata}=record;
 const event={eventId:crypto.randomUUID(),sequence:store.events.length+1,previousEventId:store.events.at(-1)?.eventId||null,actionId:record.id,kind,at:new Date().toISOString(),record:clone({...metadata,baseline:baseline?{...baseline,content:undefined}:undefined}),detail:value};
 store.events.push(event);store.checksum=hash(JSON.stringify(store.events));
 if(a.dir)atomic(path.join(a.dir,'action-facts.json'),store);else a.actionFacts=store;
 return event;
}
function intent(a,record){
 const requestContentRef=typeof record.content==='string'&&canRetain(a,record,'action-request:'+record.id)?contentObject(a,record,record.content):null;
 return append(a,record,'intent',{effectStatus:'unknown',requestContentRef});
}
function receipt(a,record){return append(a,record,'receipt',{effectStatus:'applied',result:record.result});}
function notApplied(a,record){const event=append(a,record,'not_applied',{effectStatus:'not_applied',actor:'user',reason:'用户核对后确认未生效'});project(a,event);require('./source-observations.cjs').reclassify(a,{actionId:record.id});return event;}
function canRetain(a,record,sourceId){
 if(!a.requireContextAccessPolicy)return true;
 const p=require('./access-policy-store.cjs'),scope={jobId:record.jobId,taskId:record.taskId};
 const object=p.check(a,{principalScope:p.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+sourceId,...scope},operation:'local_retention'});
 if(object.decision==='revoked')return false;
 return object.allowed||p.check(a,{principalScope:p.LOCAL,resourceScope:{kind:'snapshot_collection',key:'app',...scope},operation:'local_retention'}).allowed;
}
function contentObject(a,record,content){
 if(typeof content!=='string'||!content.trim())return null;
 const digest=hash(content),scope={jobId:record.jobId,taskId:record.taskId,principal:record.larkOpenId||null,target:record.result?.url||record.target},id=hash(JSON.stringify(scope)+digest);
 const value={id,hash:digest,bytes:Buffer.byteLength(content),scope,content};
 if(a.dir){const dir=path.join(a.dir,'effect-content');fs.mkdirSync(dir,{recursive:true,mode:0o700});atomic(path.join(dir,id+'.json'),value);readContent(a,{id,hash:digest,bytes:value.bytes});}
 else(a.effectContent||={})[id]=value;
 return {id,hash:digest,bytes:value.bytes,scope};
}
function readContent(a,ref){
 if(!ref||!/^[a-f0-9]{64}$/.test(ref.id))return null;
 const value=a.dir?JSON.parse(fs.readFileSync(path.join(a.dir,'effect-content',ref.id+'.json'),'utf8')):a.effectContent?.[ref.id];
 if(!value||hash(value.content)!==ref.hash||Buffer.byteLength(value.content)!==ref.bytes)throw Error('交付正文对象缺失或校验失败');
 return value.content;
}
function eligible(a,record){
 const t=a.data.tasks.find(t=>t.id===record.taskId),j=a.data.delegations.find(j=>j.id===record.jobId);
 if(!t||!j||t.deletedAt||t.agentCancelled||t.status==='completed'&&t.acceptedBy==='user'||j.status==='completed'||t.agentJobId!==j.id)return false;
 if(record.version!==require('./agent-writes.cjs').version(t))return false;
 if(record.larkOpenId&&(j.larkCreateGrant?.openId!==record.larkOpenId||j.larkCreateGrant?.target!==record.target))return false;
 return true;
}
function outcome(a,record,result,content){
 const task=a.data.tasks.find(t=>t.id===record.taskId),prior=a.data.sources.find(s=>s.deliveryActionId===record.id||s.id===record.result?.sourceId);
 const sourceId=result.sourceId||'effect-'+hash(record.id+hash(content||''));
 const retained=!!task&&!task.deletedAt&&!prior?.deleted&&!prior?.projectExcluded&&canRetain(a,record,prior?.id||sourceId);
 const ref=retained?contentObject(a,record,content):null;
 const event=append(a,record,'outcome',{effectStatus:'applied',result:clone(result),contentRef:ref,...(!retained&&typeof content==='string'?{discardedContentHash:hash(content)}:{})});
 project(a,event);require('./source-observations.cjs').reclassify(a,{actionId:record.id});return record.result;
}
function project(a,event){
 let r=a.data.agentActions.find(r=>r.id===event.actionId);
 if(!r){r={...clone(event.record),status:'uncertain',presentationStatus:'historical'};a.data.agentActions.push(r);}
 if(r.factSequence>=event.sequence)return;
 if(event.kind==='intent'){
  if(!['done','rejected','stale'].includes(r.status))r.status='uncertain';
  if(!r.content&&event.detail.requestContentRef&&canRetain(a,r,'action-request:'+r.id))try{r.content=readContent(a,event.detail.requestContentRef);}catch{r.readbackRecovery='原动作正文需恢复，不能重新提交';}
 }
 else if(event.kind==='receipt'){r.result={...r.result,...event.detail.result};if(r.status!=='done')r.status='uncertain';r.effectStatus='applied';if(r.tool==='request_confirmation'){r.messageId=event.record.messageId;r.receiptMessageId=event.record.receiptMessageId;}}
 else if(event.kind==='not_applied'){r.status='failed';r.effectStatus='not_applied';r.error=event.detail.reason;r.resolvedAt=event.at;}
 else if(event.kind==='outcome'){
  const current=eligible(a,r);r.result=clone(event.detail.result);r.status='done';r.effectStatus='applied';r.finishedAt=event.at;r.presentationStatus=current?'current':'historical';
  if(event.detail.contentRef&&current){
   const sourceId=r.result.sourceId||'effect-'+hash(r.id+event.detail.contentRef.hash);
   let content;try{if(canRetain(a,r,sourceId))content=readContent(a,event.detail.contentRef);else r.readbackRecovery='交付事实已保存，正文保留权限已撤回或待恢复';}catch{r.readbackRecovery='交付事实已保存，回读正文需恢复';}
   if(content){
    const id=r.result.sourceId||'effect-'+hash(r.id+event.detail.contentRef.hash),old=a.data.sources.find(s=>s.id===id);
    if(old?.deleted||old?.projectExcluded){r.presentationStatus='historical';}
    else{
     const j=a.data.delegations.find(j=>j.id===r.jobId),s=old||{id,agentJobId:j.id,projectId:j.projectId||null,identity:'lark-delivery:'+r.id,resourceKey:r.result.url||r.target,title:'交付回读 · '+r.title,content,hash:hash(content),format:'markdown',url:r.result.url,remoteId:r.result.url,remoteRevision:r.result.revision,principalScope:r.larkOpenId||null,deliveryActionId:r.id,purpose:'delivery_readback',state:'processed',createdAt:event.at,processedAt:event.at};
     if(!old)a.data.sources.unshift(s);if(!j.sourceIds.includes(id))j.sourceIds.push(id);r.result.sourceId=id;
     const links=require('./evidence-links.cjs');if(links.bindDelivery)links.bindDelivery(a,r,s);else links.initialize(a);
     delete r.readbackRecovery;
    }
   }else r.presentationStatus='historical';
  }
 }
 r.factSequence=event.sequence;r.factEventId=event.eventId;
}
function replay(a){
 try{for(const event of load(a).events)project(a,event);require('./source-observations.cjs').reclassify(a);delete a.actionFactsError;}
 catch(error){a.actionFactsError=error.message;}
}
function assertWritable(a){if(a.actionFactsError)throw Object.assign(Error(a.actionFactsError),{code:'STORAGE_FAILURE',requiresInput:true});load(a);}
module.exports={intent,receipt,outcome,notApplied,replay,eligible,assertWritable,load,readContent};
