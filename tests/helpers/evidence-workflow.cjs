'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../../desktop/core.cjs'),input=require('../../desktop/model-input.cjs'),ground=require('../../desktop/grounding.cjs');
async function fixture(t,handler){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-workflow-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));
 const calls=[],deny=async()=>{throw Error('No external services in offline workflow');};let a;
 a=new Assistant({dir,connectorRequest:deny,agentRequest:deny,webRequest:deny,chat:async(p,k,m,o)=>{const context=input.materialize(JSON.parse(m[1].content));calls.push({role:o.role,context});return handler({a,context,role:o.role});}});
 a.data.settings.evidenceGrounding=true;a.data.settings.autoComplete=false;
 await a.dispatch('saveProvider',{name:'offline',model:'mock',baseUrl:'http://127.0.0.1:1/v1',key:'offline-only',inputPrice:0,outputPrice:0});
 return {a,calls};
}
function review(a,task,context,claims,citations,issues=[]){
 return {passed:issues.length===0,summary:issues.length?'独立核验发现缺口':'独立核对当前证据',gaps:issues,groundingReview:{format:'compact-v5',scannedArtifactIds:context.artifacts.map(r=>r.id),requirements:ground.requirements(a,task).map(r=>({id:r.id,status:'satisfied',claimIds:claims.map(c=>c.id)})),citations,claims,unsupportedClaims:issues,conflicts:[],consistencyIssues:[]}};
}
module.exports={fixture,review};
