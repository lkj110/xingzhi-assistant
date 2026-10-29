'use strict';
// Observe additional coverage after execution; never change model input, verdict,
// quality denominators, or the number of requests to force a title citation.
const fs=require('node:fs'),path=require('node:path'),base=require('../foundation-citation-offline-runner/report.cjs');
const {read}=require('./identity.cjs'),{coverage}=require('./coverage.cjs'),{hash}=require('../../desktop/evidence-basis.cjs'),{digest}=require('../foundation-marker-runner/phases.cjs');
const rows=v=>Array.isArray(v)?v:[];
function response(t){if(!t||t.error||t.role!=='verify')return null;try{return JSON.parse(JSON.parse(t.rawOutput).response_json);}catch{return null;}}
function titleQuotes(v){return [...rows(v?.groundingReview?.citations),...rows(v?.groundingReview?.claims).flatMap(c=>rows(c?.citations))].filter(q=>q?.field==='title');}
function titleStage(draft,checked,terminals){
 const emitted=terminals.some(t=>titleQuotes(response(t)).length>0),last=terminals.filter(t=>t.role==='verify').at(-1),v=response(last);
 const g=checked?.task?.grounding,bound=!!draft?.contentBinding&&draft.contentBinding===checked?.contentBinding&&digest(draft.draft)===digest(checked.draft);
 const shared=new Map(rows(v?.groundingReview?.citations).map(q=>[q?.id,q]));
 const titleBindingValidated=bound&&v?.passed===true&&g?.passed===true&&g.reused!==true&&checked.task.verification?.passed===true&&g.reportHash===hash({...g,reportHash:undefined})&&rows(v.groundingReview?.claims).some(c=>{
  if(typeof c?.text!=='string')return false;
  const references=v.groundingReview.format==='compact-v3'?rows(c.citationIds).map(id=>shared.get(id)):rows(c.citations),saved=rows(g.claims).find(p=>p?.artifactId===c.artifactId&&p.text===c.text.trim());
  return references.some(q=>q?.field==='title'&&(q.start===undefined||q.start===0)&&rows(saved?.citations).some(p=>p?.field==='title'&&p.sourceId===q.sourceId&&p.quote===q.quote&&p.quote===p.title&&p.fieldHash===hash(p.quote)&&typeof p.version==='string'&&p.version.length>0&&(q.version===undefined||q.version===p.version)));
 });
 return {modelTitleCitationEmitted:emitted,titleBindingValidated:!!titleBindingValidated,liveTitleBindingValidated:!!titleBindingValidated&&last.transportDispatched===true&&last.synthetic!==true};
}
function report(directory,adjudication){
 const result=base.report(directory,adjudication),summary=read(path.join(directory,'summary.json')),stages=[],terminals=summary.ledger.attempts.map(a=>read(path.join(directory,'calls',a.id+'-terminal.json')));
 for(const c of summary.results)for(const stage of ['initial','revision']){
  const d=path.join(directory,c.caseId+'-'+stage+'-draft.json'),o=path.join(directory,c.caseId+'-'+stage+'-outcome.json');if(!fs.existsSync(d))continue;
  stages.push({caseId:c.caseId,stage,...titleStage(read(d),fs.existsSync(o)?read(o):null,terminals.filter(t=>t.caseId===c.caseId&&[stage,stage+'-human-recheck'].includes(t.evaluationPhase)))});
 }
 result.branchCoverage=coverage(summary,stages);return result;
}
module.exports={...base,report,titleStage};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{output:{type:'string'},adjudication:{type:'string'}}});console.log(JSON.stringify(report(values.output,values.adjudication?read(values.adjudication):undefined),null,2));}
