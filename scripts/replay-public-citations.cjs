'use strict';
// Replay original persisted evidence through public projections in a disposable
// profile. No model, acceptance, evidence edits or reconstructed permissions.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs'),{hash}=require('../desktop/evidence-basis.cjs');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
async function replay({workspace,run,output}){
 for(const file of [workspace,run,output])assert.ok(path.isAbsolute(file));
 workspace=fs.realpathSync(workspace);run=fs.realpathSync(run);
 output=path.join(fs.realpathSync(path.dirname(output)),path.basename(output));
 assert.ok(!fs.existsSync(output),'Output must be new');
 const within=(root,target)=>{const r=path.relative(root,target);return !r||(!r.startsWith('..')&&!path.isAbsolute(r));};
 assert.ok(!within(workspace,output)&&!within(run,output),'Frozen inputs cannot contain output');
 const tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'public-citation-replay-'));
 const sourceFiles=[],remember=file=>{sourceFiles.push({file,sha256:sha(file)});return file;};let a,attempts=0;
 try{
  for(const name of ['workspace.json','work-journal.json','access-policy.json','authorization-migration.json','action-facts.initialized','action-facts.json','action-ledger.json','spend-ledger.json','stewardship-ledger.json']){
   const file=path.join(workspace,name);if(fs.existsSync(file))fs.copyFileSync(remember(file),path.join(dir,name));
  }
  const forbidden=async()=>{attempts++;throw Error('Offline replay forbids model/network transport');};
  a=new Assistant({dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,officeRequest:forbidden,webRequest:forbidden,feedRequest:forbidden});
  const id='494badb1-722c-4b4e-a9d5-c9cb8d60d0d0',task=a.task(id),raw=structuredClone(task.grounding);
  const outcome=read(remember(path.join(run,'F03-botang-notice-initial-outcome.json'))),draft=read(remember(path.join(run,'F03-botang-notice-initial-draft.json')));
  const terminal=read(remember(path.join(run,'calls/6fdd9b7f-b2dc-426e-9d32-a659af8e444b-terminal.json')));
  const observer=require('../evaluations/foundation-citation-business-runner/report.cjs');
  assert.equal(raw.reportHash,hash({...raw,reportHash:undefined}));assert.equal(outcome.task.grounding.reportHash,raw.reportHash);
  assert.notEqual(outcome.task.grounding.reportHash,hash({...outcome.task.grounding,reportHash:undefined}));
  const before=hash(a.data),models=a.data.modelCalls.length,results=[];
  const projections=[['full',a.publicState({full:true})],['summary',a.publicState({summary:true})],['stateView',(await a.dispatch('stateView')).state],['export',await a.dispatch('export')],['uiExport',await a.dispatch('uiCommand',{action:'export'})]];
  for(const [kind,state]of projections){const report=state.tasks.find(t=>t.id===id).grounding;assert.deepEqual(report,raw);assert.equal(report.reportHash,hash({...report,reportHash:undefined}));results.push({kind,equalsRaw:true,originalHashValid:true});}
  const oldResult=observer.titleStage(draft,outcome,[terminal]),newResult=observer.titleStage(draft,{...outcome,task:projections[3][1].tasks.find(t=>t.id===id)},[terminal]);
  assert.equal(oldResult.titleBindingValidated,false);assert.equal(newResult.liveTitleBindingValidated,true);
  assert.equal(hash(a.data),before);assert.equal(a.data.modelCalls.length,models);assert.equal(attempts,0);
  for(const item of sourceFiles)assert.equal(sha(item.file),item.sha256);
  const result={schema:1,kind:'offline-original-report-projection-replay',createdAt:new Date().toISOString(),sourceRun:'172cf200-1634-4ff6-880c-09dc91d75a1d',caseId:'F03-botang-notice',taskId:id,
   sourceFiles:sourceFiles.map(r=>({file:path.basename(r.file),sha256:r.sha256})),reportHash:raw.reportHash,projections:results,originalObserverTitleBinding:false,newProjectionObserverTitleBinding:true,
   originalReportAndWorkspaceUnchanged:true,sourcePermissionsCopiedUnchanged:true,oldRunAndMetricsUnchanged:true,modelCallsAdded:0,newHumanAcceptance:false,newCandidateLiveAcceptance:false};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
 }finally{
  if(a){require('../desktop/deadline-scheduler.cjs').dispose(a);require('../desktop/access.cjs').cancel(a);a.streamController?.dispose();}
  assert.equal(path.dirname(fs.realpathSync(dir)),tempRoot);fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
}
module.exports={replay};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{workspace:{type:'string'},run:{type:'string'},output:{type:'string'}}});replay(values).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack);process.exitCode=1;});}
