// Short synchronous commits preserve live object references on failure. No network awaits here.
const fs=require('node:fs');
function snapshot(root){
 const records=new Map();
 function visit(value){if(!value||typeof value!=='object'||records.has(value))return;const copy=Object.entries(value);records.set(value,{copy,length:Array.isArray(value)?value.length:null});for(const [,v]of copy)visit(v);}
 visit(root);
 return ()=>{for(const [object,{copy,length}]of records){for(const key of Object.keys(object))delete object[key];if(length!==null)object.length=length;for(const [key,value]of copy)object[key]=value;}return root;};
}
function commit(a,mutate,{expectedRevision,expectedEntities=[],workEvents,commitReceipt,commitId,save=true}={}){
 if(mutate.constructor?.name==='AsyncFunction')throw Error('状态提交不得等待异步操作');
 if(expectedRevision!==undefined&&expectedRevision!==(a.data.runtime?.revision||0))throw Object.assign(Error('资料已变化，请刷新后重试'),{code:'STATE_STALE'});
 for(const expected of expectedEntities){const row=(a.data[expected.kind==='job'?'delegations':'tasks']||[]).find(r=>r.id===expected.id);if(!row||expected.workRevision!==undefined&&expected.workRevision!==(row.workRevision??1)||expected.eventId!==undefined&&expected.eventId!==(row.workEvent?.eventId||null))throw Object.assign(Error('当前工作修订已变化'),{code:'STATE_STALE'});}
 const initial=a.data,undo=snapshot(initial),prior=a.data.runtime?.commitId;
 let receipt=commitReceipt;
 try{if(workEvents)receipt=require('./work-journal.cjs').append(a,workEvents,{commitId});const result=mutate(receipt);if(result?.then)throw Error('状态提交不得等待异步操作');if(save)a.save();return result;}
 catch(error){receipt ||= error.commitReceipt;let committed=error.committed===true||receipt?.committed===true;
  if(receipt?.committed)require('./work-journal.cjs').markPending(a,receipt,error);
  if(!committed&&a.file)try{const saved=JSON.parse(fs.readFileSync(a.file,'utf8'));committed=!!saved.runtime?.commitId&&saved.runtime.commitId!==prior&&saved.runtime.commitId===a.data.runtime?.commitId;}catch{}
  if(!committed)a.data=undo();else error.committed=true;
  throw error;
 }
}
module.exports={commit,snapshot};
