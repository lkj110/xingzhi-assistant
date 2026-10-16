const evidence=require('./evidence-basis.cjs');
// Ordered plans retain a conservative dependency on preceding steps. Each receipt
// records exactly which inputs were used, independently of the display title.
function snapshot(a,task,step){
 const job=a.data.delegations.find(j=>j.id===task.agentJobId),index=task.steps.indexOf(step);
 const sources=evidence.taskSources(a,task);
 const dependencies=task.steps.slice(0,index).map(s=>({stepId:s.id,key:s.key,artifactHash:s.artifactId?evidence.hash(a.data.artifacts.find(r=>r.id===s.artifactId)?.content):null,receipt:s.evidence||null}));
 const inputs={intent:evidence.intent(job,task),sources,dependencies,...(step.outputRole||step.targetArtifactId||task.primaryArtifactId?{output:{role:step.outputRole,targetArtifactId:step.targetArtifactId,primaryArtifactId:task.primaryArtifactId,targetHash:step.targetArtifactId?evidence.hash(a.data.artifacts.find(r=>r.id===step.targetArtifactId&&r.taskId===task.id)?.content):undefined}}:{})};
 return {version:1,...inputs,hash:evidence.hash(inputs)};
}
function record(a,task,step){step.inputBasis=snapshot(a,task,step);step.outputHash=evidence.hash(a.data.artifacts.find(r=>r.id===step.artifactId)?.content);}
module.exports={snapshot,record};
