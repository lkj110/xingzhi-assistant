const evidence=require('./evidence-basis.cjs');
function check(a,job,task){
 const content=task.contentVerification;
 if(content?.passed===false&&(!content.basis||content.basis===require('./execution-control.cjs').contentBasis(a,job,task)))return content;
 const verified=task.verification;
 if(verified?.passed===false&&(!verified.basis||verified.basis===require('./acceptance.cjs').basis(a,task)))return verified;
 return null;
}
function basis(a,job,task){
 const value=check(a,job,task),request=task.evidenceRequest;
 return {check:value?.basis?{basis:value.basis,gaps:value.gaps,details:value.gapDetails}:null,request:request?{kind:request.kind,basis:request.basis,gaps:request.gaps,artifactId:request.artifactId}:null};
}
function planning(a,job,task){
 if(task.evidenceRequest)return true;
 const value=check(a,job,task);
 return !!value?.gaps?.length&&((value.gapDetails||[]).some(d=>['evidence','binding','delivery'].includes(d.kind))||!require('./revision-protocol.cjs').target(a,task,value));
}
function key(a,job,task){return evidence.hash(basis(a,job,task));}
module.exports={check,basis,planning,key};
