'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function install(a,task,spec,root){
 const f=spec.fixture||{},tokens={};
 // Seed old memory before creating the delegation, so a historical fixture
 // does not spuriously invalidate a plan that has not begun yet.
 for(const m of f.expiredMemories||[]){
  let source;
  if(Number.isInteger(m.sourceIndex)){
   const expected=spec.sources?.[m.sourceIndex];if(!expected)throw Error('Fixture memory source index missing');
   const matches=a.data.sources.filter(s=>s.title===expected.title.trim()&&s.content===expected.content.trim());if(matches.length!==1)throw Error('Fixture memory source ambiguous');source=matches[0];
  }
  await require(path.join(root,'desktop/memory.cjs')).dispatch(a,'memorySave',{kind:'fact',title:m.title,content:m.content,...(source?{sourceId:source.id}:{})});
  const saved=a.data.memories.findLast(x=>x.title===m.title);if(!saved)throw Error('Fixture memory was not saved');saved.expiresAt=m.expiresAt;
 }
 const agent=require(path.join(root,'desktop/agent.cjs')),folder=fs.realpathSync(a.dir);
 a.data.folders.push({id:'evaluation-input',name:'本次合成核验材料',path:folder});
 const job=agent.buildJob(a,{goal:task.title+'\n'+task.description,folderIds:['evaluation-input'],allowWeb:false,useOutputFolder:false,fileMode:'off',autoAccept:false,maxActions:12},{outputFolder:folder});
 a.data.delegations.push(job);task.agentJobId=job.id;task.agentKey='evaluation-task';job.taskIds=[task.id];job.sourceIds=[...task.sourceIds];task.steps.forEach((step,i)=>step.key='evaluation-step-'+i);
 for(const file of f.inputFiles||[]){if(typeof file.fileName!=='string'||path.basename(file.fileName)!==file.fileName)throw Error('Fixture file must be local');fs.writeFileSync(path.join(folder,file.fileName),file.content,{flag:'wx'});}
 if(f.existingAction){
  const x=f.existingAction;if(typeof x.fileName!=='string'||path.basename(x.fileName)!==x.fileName)throw Error('Fixture file must be local');
  // A past artifact is history, not a step to regenerate in today's plan.
  const step={id:crypto.randomUUID()};
  const artifact={id:crypto.randomUUID(),taskId:task.id,stepId:step.id,title:x.title,content:x.content,origin:'user_import',createdAt:'2025-01-01T00:00:00Z'};step.artifactId=artifact.id;
  a.data.artifacts.push(artifact);require(path.join(root,'desktop/protocol-access.cjs')).retain(a,'artifact',artifact,{task});
  const target=path.join(folder,x.fileName);fs.writeFileSync(target,x.content,{flag:'wx'});
  const action={id:crypto.randomUUID(),jobId:job.id,taskId:task.id,tool:'write_file',status:'done',artifactId:artifact.id,content:artifact.content,target,result:{path:target,verified:true},finishedAt:'2025-01-01T00:00:00Z'};a.data.agentActions.push(action);
  tokens.__EXISTING_ACTION_ID__=action.id;tokens.__EXISTING_ARTIFACT_ID__=artifact.id;
 }
 for(const field of ['description','criteria'])for(const [key,value] of Object.entries(tokens))task[field]=String(task[field]||'').replaceAll(key,value);
 for(const [key,value] of Object.entries(tokens))job.goal=job.goal.replaceAll(key,value);
 a.save();return tokens;
}
module.exports={install};
