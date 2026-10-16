// Explicit user deletion is stronger than an ACL revocation. This small,
// independent command log survives workspace restore; it never stores bodies.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {hash}=require('./evidence-basis.cjs');
const file=a=>path.join(a.dir,'source-deletions.json');
function read(a){
  if(!a.dir)return a.data.sourceDeletions||[];
  let log;
  try{log=JSON.parse(fs.readFileSync(file(a),'utf8'));}
  catch(error){if(error.code==='ENOENT'&&!a.data.sourceDeletions?.length)return [];throw Object.assign(Error('材料删除记录无法读取，请先恢复记录'),{code:'SOURCE_DELETION_INVALID'});}
  if(log.version!==1||!Array.isArray(log.events)||hash(log.events)!==log.checksum||new Set(log.events.map(e=>e.sourceId)).size!==log.events.length||log.events.some((e,i)=>!e.sourceId||e.sequence!==i+1||e.actor!=='user'||e.command!=='deleteSource'))throw Object.assign(Error('材料删除记录校验失败'),{code:'SOURCE_DELETION_INVALID'});
  return log.events;
}
function project(a,events){
  const ids=new Set(events.map(e=>e.sourceId));a.data.sourceDeletions=structuredClone(events);
  a.data.sources=a.data.sources.filter(s=>!ids.has(s.id));
  for(const j of a.data.delegations||[])j.sourceIds=(j.sourceIds||[]).filter(id=>!ids.has(id));
  for(const t of a.data.tasks||[]){
    t.sourceIds=(t.sourceIds||[]).filter(id=>!ids.has(id));t.supersededSourceIds=(t.supersededSourceIds||[]).filter(id=>!ids.has(id));
    for(const b of t.contextBindings||[])if(ids.has(b.sourceId))b.state='withdrawn';
  }
}
function replay(a){const events=read(a);if(events.length)project(a,events);return events;}
function record(a,sourceId,{trusted=false}={}){
  if(!trusted||typeof sourceId!=='string'||!sourceId.trim())throw Error('材料删除需要明确用户命令');
  const events=read(a);if(events.some(e=>e.sourceId===sourceId)){project(a,events);return;}
  events.push({eventId:crypto.randomUUID(),sequence:events.length+1,sourceId,actor:'user',command:'deleteSource',at:new Date().toISOString()});
  if(a.dir){
    const temporary=file(a)+'.'+crypto.randomUUID()+'.tmp';let committed=false;
    try{
      const fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,JSON.stringify({version:1,events,checksum:hash(events)}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,file(a));committed=true;
      const directory=fs.openSync(a.dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
    }catch(error){if(committed){project(a,events);error.committed=true;}throw error;}
    finally{if(!committed)try{fs.unlinkSync(temporary);}catch{}}
  }
  project(a,events);
}
module.exports={record,replay};
