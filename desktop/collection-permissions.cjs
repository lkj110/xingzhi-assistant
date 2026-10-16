'use strict';
// Local retention delegated by an explicit collector configuration. This is not
// a remote ACL and is never called by restore or observation reclassification.
const policy=require('./access-policy-store.cjs');
const tables={folder:'folders',feed:'feedConnections',web:'webConnections',connector:'connectors'};
const tokens=new WeakMap();
function spec(kind,row){
 if(!tables[kind]||!row?.id)throw Error('采集范围无效');
 const scope={kind,projectId:row.projectId||null,...(kind==='folder'?{path:row.path}:kind==='connector'?{provider:row.provider||'lark',type:row.kind,target:row.target,credential:row.sealedToken?policy.hash(row.sealedToken):null}:{url:row.url})};
 if(!(scope.path||scope.target||scope.url))throw Error('采集目标无效');
 return {principalScope:policy.LOCAL,resourceScope:{kind:'collection',key:kind+':'+row.id,revision:policy.hash(scope)},operations:['local_retention','local_read']};
}
function legacy(data){
 return Object.entries(tables).flatMap(([kind,table])=>(data[table]||[]).filter(row=>!row.removedAt&&!row.deletedAt).flatMap(row=>{try{return [{...spec(kind,row),source:`${table}:${row.id}:collection`,decision:'allow'}];}catch{return [];}}));
}
function configure(a,kind,row,{before,command='collection_configure',trusted=false}={}){
 if(!trusted)throw Error('采集保留许可需要明确用户配置');
 if(!a.dir)return;
 const next=spec(kind,row),prior=before&&spec(kind,before),opts={trusted:true,actor:'user_command',command};
 if(prior&&policy.hash(prior)!==policy.hash(next))policy.revoke(a,prior,opts);
 return policy.grant(a,next,opts);
}
function remove(a,kind,row,command){if(a.dir)return policy.revoke(a,spec(kind,row),{trusted:true,actor:'user_command',command});}
function begin(a,kind,row){
 const requested=spec(kind,row),proofs=requested.operations.map(operation=>policy.check(a,{...requested,operation}));
 const token=Object.freeze({});tokens.set(token,{dir:a.dir,kind,id:row.id,spec:requested,proofs});return token;
}
function current(a,token){
 const proof=tokens.get(token);if(!proof||proof.dir!==a.dir)throw Error('采集保留范围缺少当前请求依据');
 const row=(a.data[tables[proof.kind]]||[]).find(r=>r.id===proof.id&&!r.removedAt&&!r.deletedAt);
 if(!row||policy.hash(spec(proof.kind,row))!==policy.hash(proof.spec))throw Error('采集范围已变化，旧响应不能获得新范围许可');
 const checks=proof.spec.operations.map(operation=>policy.check(a,{...proof.spec,operation}));
 return {proof,row,allowed:checks.every((c,i)=>c.allowed&&proof.proofs[i].allowed&&c.policyId===proof.proofs[i].policyId&&c.grantRevision===proof.proofs[i].grantRevision)};
}
function attach(a,kind,row,source,checked,token){
 const proof=current(a,token||begin(a,kind,row));
 if((source.projectId||null)!==(proof.row.projectId||null))throw Error('材料不属于当前采集项目');
 const observations=require('./source-observations.cjs');
 if(!checked.allowInput)return null;
 const id=checked.sourceId,old=a.data.sources.find(s=>s.id===id||s.observationId===checked.observationId);
 if(!old&&a.dir){
  for(const operation of ['local_retention','local_read'])if(policy.check(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+id},operation}).decision==='revoked')throw Error('来源正文已撤回，采集不能重新授权');
  if(a.data.sourceDeletions?.some(e=>e.sourceId===id))throw Error('来源已删除，采集不能恢复正文');
 }
 const saved=observations.attach(a,source,checked);if(!saved||old||!a.dir)return saved;
 if(!proof.allowed){saved.accessPolicyQuarantined=true;return saved;}
 try{policy.retainCreated(a,'source',saved,{trusted:true,actor:'authorization_policy',command:'collection_ingest',collection:proof.proof.spec});}
 catch(error){if(!error.committed)a.data.sources=a.data.sources.filter(s=>s!==saved);throw error;}
 return saved;
}
module.exports={spec,legacy,configure,remove,begin,attach};
