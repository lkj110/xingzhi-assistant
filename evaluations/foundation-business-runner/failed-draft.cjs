'use strict';
// Preserve a produced draft even when the subsequent verification never returns.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{write}=require('./identity.cjs'),{digest}=require('../foundation-marker-runner/phases.cjs');
function capture({directory,caseId,stage,input,data,taskId,error,priorDraftHash}){
 assert.ok(['initial','revision'].includes(stage));assert.ok(/^[A-Za-z0-9_-]+$/.test(caseId));
 const file=path.join(directory,`${caseId}-${stage}-draft.json`);if(fs.existsSync(file))return {captured:false,reason:'already-recorded'};
 const task=data.tasks.find(t=>t.id===taskId),draft=data.artifacts.find(a=>a.id===(task?.primaryArtifactId||task?.steps?.[0]?.artifactId));
 if(!draft||typeof draft.content!=='string')return {captured:false,reason:'no-draft'};
 if(stage==='revision'&&(!priorDraftHash||digest(draft)===priorDraftHash))return {captured:false,reason:'revision-produced-no-new-draft'};
 write(file,{input,task,draft,technicalInterrupted:true,technicalError:{code:error?.code||null,message:error?.message||String(error)}});return {captured:true,draftHash:digest(draft)};
}
module.exports={capture};
