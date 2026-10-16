// Preserve references for unchanged entities; a stale delta is never applied.
export function mergeWorkspace(previous,envelope){
 if(envelope.unchanged)return previous;
 if(envelope.patch){
  if(!previous||previous.viewRevision!==envelope.baseRevision)throw Error('工作空间已更新，需要重新同步');
  const next={...previous};
  for(const [key,change] of Object.entries(envelope.patch)){
   if(change.entities){const rows=new Map((previous[key]||[]).map(r=>[r.id,r]));for(const row of change.upsert)rows.set(row.id,row);next[key]=change.order.map(id=>rows.get(id));}
   else next[key]=change.value;
  }
  next.viewRevision=envelope.revision;return next;
 }
 const next=envelope.state;
 if(!next)return previous;
 if(previous?.viewRevision===next.viewRevision)return previous;
 if(previous)for(const [key,value] of Object.entries(next))if(Array.isArray(value)&&Array.isArray(previous[key])){
  const old=new Map(previous[key].filter(r=>r?.id).map(r=>[r.id,r]));
  const merged=value.map(row=>row?._viewRevision&&old.get(row.id)?._viewRevision===row._viewRevision?old.get(row.id):row);
  next[key]=merged.length===previous[key].length&&merged.every((row,i)=>row===previous[key][i])?previous[key]:merged;
 }
 return next;
}
export function createWorkspaceSync({fetchState,onState,onError}){
 let value=null,inflight=null,epoch=0,again=false,disposed=false;
 async function refresh(force=false){
  if(disposed)return;
  if(force){epoch++;again=true;}
  if(inflight)return inflight;
  inflight=(async()=>{do{
   again=false;const started=epoch;
   try{let response=await fetchState(value?.viewRevision);if(disposed||started!==epoch)continue;
    if(response.patch&&response.baseRevision!==value?.viewRevision)response=await fetchState();
    if(disposed||started!==epoch)continue;
    const next=mergeWorkspace(value,response);if(next!==value){value=next;onState(next);}onError?.('');
   }catch(error){if(!disposed&&started===epoch)onError?.(error.message);}
  }while(again&&!disposed);})().finally(()=>{inflight=null;});return inflight;
 }
 return {refresh,dispose(){disposed=true;epoch++;},get value(){return value;}};
}
