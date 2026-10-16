// Called only with user-authored instructions, never with source text or model output.
const path=require('node:path');
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[ _-]+/g,' ');
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function aliases(cap){return [...new Set([cap.name,cap.path&&path.basename(cap.path)].filter(Boolean).map(normalize))].filter(s=>s.length>=3);}
function matches(text,alias){return new RegExp(`(?<![a-z0-9_-])${alias.split(' ').map(escape).join('[ _-]+')}(?![a-z0-9_-])`,'u').test(text);}
function bind(a,job,note){
 if(!job||job.ruleId||typeof note!=='string'||!note.trim())return [];
 const sentences=note.split(/[。；;\n!?！？]/).map(s=>s.normalize('NFKC').toLowerCase()),caps=(a.data.capabilities||[]).filter(c=>['dw','repository'].includes(c.kind)&&c.enabled&&!c.removedAt&&c.allowedTools?.length);
 const chosen=[];
 for(const cap of caps){
  const names=aliases(cap);
  const mentioned=sentences.filter(s=>names.some(n=>matches(s,n)));
  if(!mentioned.length||mentioned.some(s=>/(?:不要|不用|无需|不使用|不绑定|不接入|不调用|禁用|移除|取消|尚未|未授权|without|do not|don't|disable|remove)/i.test(s)))continue;
  // A basename shared by multiple mounted repositories needs an unambiguous name or path.
  const unique=names.some(n=>mentioned.some(s=>matches(s,n))&&caps.filter(c=>aliases(c).includes(n)).length===1)||note.includes(cap.path);
  if(!unique)continue;
  const previous=job.capabilityGrants?.find(g=>g.id===cap.id);
  if(previous||a.dir&&require('./access-policy-store.cjs').capabilityPreviouslyBound(a,job.id,cap.id))continue; // Prior independent scope survives removal of workspace grant projections.
  chosen.push({id:cap.id,revision:cap.revision});
 }
 if(!chosen.length)return [];
 const before=structuredClone(job);
 job.capabilityGrants=[...(job.capabilityGrants||[]),...chosen];
 if(a.dir)require('./access-policy-store.cjs').syncTrustedJob(a,job,{before,trusted:true,actor:'user_command',command:'bind_named_repository'});
 const at=new Date().toISOString();
 job.capabilityBindings=[...(job.capabilityBindings||[]),...chosen.map(g=>({...g,at,origin:'user_instruction',reason:note.slice(0,2000)}))].slice(-100);
 a.event('已按补充说明关联能力仓库',chosen.map(g=>caps.find(c=>c.id===g.id).name).join('、'),job.taskIds?.[0]);
 return chosen;
}
module.exports={bind};
