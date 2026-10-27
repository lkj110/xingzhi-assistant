'use strict';

// Offline analysis only. This module never invokes a model or changes its source report.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {summarize}=require('./grounding-eval-metrics.cjs');
const validNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:'','utf8').digest('hex');
const key=row=>`${row.caseId}\u0000${row.arm}`;
const median=values=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};

function wilson95(numerator,denominator){
 if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||numerator<0||denominator<0||numerator>denominator)throw new TypeError('Invalid binomial counts');
 if(!denominator)return {lower:null,upper:null,confidence:0.95,method:'Wilson score'};
 const z=1.959963984540054,p=numerator/denominator,d=1+z*z/denominator;
 const center=(p+z*z/(2*denominator))/d,half=z*Math.sqrt(p*(1-p)/denominator+z*z/(4*denominator*denominator))/d;
 return {lower:Math.max(0,center-half),upper:Math.min(1,center+half),confidence:0.95,method:'Wilson score'};
}

function fraction(numerator,denominator){
 return {numerator,denominator,rate:denominator?numerator/denominator:null,interval95:wilson95(numerator,denominator),
  zeroEventOneSidedUpper95:numerator===0&&denominator>0?1-Math.pow(0.05,1/denominator):null};
}

function attachIntervals(value){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(attachIntervals);
 const result=Object.fromEntries(Object.entries(value).map(([name,item])=>[name,attachIntervals(item)]));
 if(Number.isSafeInteger(value.numerator)&&Number.isSafeInteger(value.denominator)&&Object.hasOwn(value,'rate'))Object.assign(result,fraction(value.numerator,value.denominator));
 return result;
}

function applyAudit(report,audit){
 const rows=report.rows.map(row=>({...row}));
 if(!audit)return {rows,metadata:{provided:false,reviewedRows:0,changedRows:0,technicalCorrections:0},reviews:new Map()};
 if(audit.schema!==1||audit.reportIdentity!==report.identity||!Array.isArray(audit.overrides))throw new Error('Audit schema or report identity mismatch');
 const byKey=new Map();
 for(const row of rows){if(byKey.has(key(row)))throw new Error('Duplicate report row cannot be audited');byKey.set(key(row),row);}
 const reviews=new Map(),changes=[];let technicalCorrections=0,reasonAnnotations=0;
 for(const override of audit.overrides){
  const id=key(override),row=byKey.get(id);
  if(!row||reviews.has(id))throw new Error(`Unknown or duplicate audit row: ${override.caseId}/${override.arm}`);
  if(typeof override.candidateHash!=='string'||override.candidateHash!==hash(row.candidate))throw new Error(`Stale audit candidate: ${override.caseId}/${override.arm}`);
  if(!isDeepStrictEqual(override.originalGrade,row.grade))throw new Error(`Stale original grade: ${override.caseId}/${override.arm}`);
  if(!override.grade||['correct','hallucination','abstained'].some(field=>typeof override.grade[field]!=='boolean'))throw new Error('Audit must supply boolean grade fields');
  if(Object.hasOwn(override.grade,'parseable')&&override.grade.parseable!==row.grade.parseable)throw new Error('Audit cannot change strict JSON parseability');
  const nextGrade={...row.grade,...override.grade};
  const changed=['parseable','correct','hallucination','abstained','answer','certainty'].some(field=>nextGrade[field]!==row.grade[field]);
  if(nextGrade.reason!==row.grade.reason)reasonAnnotations++;
  row.grade=nextGrade;
  if(Object.hasOwn(override,'technicalError')){
   if(override.technicalError!==null&&typeof override.technicalError!=='string')throw new Error('Invalid audited technicalError');
   if(override.technicalError!==row.technicalError){technicalCorrections++;row.technicalError=override.technicalError;}
  }
  row.auditReview=override.review||null;
  reviews.set(id,override);
  if(changed)changes.push({caseId:row.caseId,arm:row.arm,reason:override.reason||nextGrade.reason});
 }
 return {rows,reviews,metadata:{provided:true,reviewMethod:audit.reviewMethod||null,updatedAt:audit.updatedAt||null,
  reviewedRows:reviews.size,changedRows:changes.length,reasonAnnotations,technicalCorrections,changes,
  equivalenceRules:audit.equivalenceRules||[],basisScoring:audit.basisScoring||null}};
}

const resourceGetters={
 inputTokens:row=>row.usage?.inputTokens,
 outputTokens:row=>row.usage?.outputTokens,
 cachedInputTokens:row=>row.usage?.cachedInputTokens,
 uncachedInputTokens:row=>validNumber(row.usage?.inputTokens)&&validNumber(row.usage?.cachedInputTokens)?Math.max(0,row.usage.inputTokens-row.usage.cachedInputTokens):null,
 totalTokens:row=>validNumber(row.usage?.inputTokens)&&validNumber(row.usage?.outputTokens)?row.usage.inputTokens+row.usage.outputTokens:null,
 calls:row=>row.calls,
 durationMs:row=>row.durationMs
};

function pairRows(rows){
 const grouped=new Map();
 for(const row of rows){if(!grouped.has(row.caseId))grouped.set(row.caseId,{baseline:[],strict:[]});grouped.get(row.caseId)[row.arm].push(row);}
 const pairs=[],excluded=[];
 for(const [caseId,group] of grouped){if(group.baseline.length===1&&group.strict.length===1)pairs.push({caseId,baseline:group.baseline[0],strict:group.strict[0]});else excluded.push(caseId);}
 return {pairs,excluded};
}

function pairedResources(rows){
 const {pairs,excluded}=pairRows(rows),fields={};
 for(const [name,get] of Object.entries(resourceGetters)){
  const complete=[],missing=[];
  const valid=value=>name==='durationMs'?validNumber(value):Number.isSafeInteger(value)&&value>=0;
  for(const pair of pairs){const baseline=get(pair.baseline),strict=get(pair.strict);if(!valid(baseline)||!valid(strict)){missing.push(pair.caseId);continue;}
   complete.push({caseId:pair.caseId,baseline,strict,delta:strict-baseline,relativeChangePercent:baseline?(strict-baseline)/baseline*100:null});}
  const baselineTotal=complete.reduce((sum,item)=>sum+item.baseline,0),strictTotal=complete.reduce((sum,item)=>sum+item.strict,0);
  fields[name]={eligiblePairs:complete.length,missingPairs:missing.length,missingCaseIds:missing,baselineTotal:complete.length?baselineTotal:null,strictTotal:complete.length?strictTotal:null,
   absoluteDelta:complete.length?strictTotal-baselineTotal:null,totalRelativeChangePercent:baselineTotal?(strictTotal-baselineTotal)/baselineTotal*100:null,
   meanBaseline:complete.length?baselineTotal/complete.length:null,meanStrict:complete.length?strictTotal/complete.length:null,
   meanAbsoluteDelta:complete.length?(strictTotal-baselineTotal)/complete.length:null,
   medianBaseline:median(complete.map(item=>item.baseline)),medianStrict:median(complete.map(item=>item.strict)),
   medianAbsoluteDelta:median(complete.map(item=>item.delta)),medianRelativeChangePercent:median(complete.map(item=>item.relativeChangePercent).filter(value=>value!==null)),
   relativeChangeDenominator:complete.filter(item=>item.baseline>0).length,zeroBaselinePairs:complete.filter(item=>item.baseline===0).length,perCase:complete};
 }
 return {pairs:pairs.length,unpairedOrRepeatedCaseIds:excluded,deltaConvention:'strict minus baseline; relative change divides by baseline; medians use paired cases',
  missingUsagePolicy:'Both arms must report a resource for that case. Pair-subset totals are not full-run totals when eligiblePairs < pairs.',fields};
}

function summarizeLane(rows,{audited=false}={}){
 const result=attachIntervals(summarize(rows));
 for(const arm of ['baseline','strict']){
  const group=rows.filter(row=>row.arm===arm),nontechnical=group.filter(row=>!row.technicalError),correct=nontechnical.filter(row=>row.grade?.correct===true);
  const countBlocked=items=>items.filter(row=>row.delivered!==true).length;
  const unknown=correct.filter(row=>row.spec?.expected?.certainty==='unknown'),proposal=correct.filter(row=>row.spec?.expected?.certainty==='proposal');
  const supported=correct.filter(row=>row.auditReview?.basisStatus==='supported');
  const incorrect=nontechnical.filter(row=>row.goldCandidateCorrect===false),goldCorrect=nontechnical.filter(row=>row.goldCandidateCorrect===true);
  Object.assign(result.byArm[arm],{
   allCorrectCandidateFalseBlock:{...fraction(countBlocked(correct),correct.length),definition:'Correct answer and certainty, including unknown/proposal; excludes technical failures. Basis completeness is not guaranteed.'},
   correctUnknownNotDelivered:fraction(countBlocked(unknown),unknown.length),correctProposalNotDelivered:fraction(countBlocked(proposal),proposal.length),
   fullySupportedCandidateFalseBlock:audited?{...fraction(countBlocked(supported),supported.length),reviewedOnly:true,definition:'Correct answer/certainty plus source-reviewed basisStatus=supported; excludes technical failures.'}:null,
   basisReview:audited?{reviewed:group.filter(row=>row.auditReview).length,supported:group.filter(row=>row.auditReview?.basisStatus==='supported').length,
    insufficient:group.filter(row=>row.auditReview?.basisStatus==='insufficient').length,unsupported:group.filter(row=>row.auditReview?.basisStatus==='unsupported').length,
    basisHallucinations:group.filter(row=>row.auditReview?.basisHallucination===true).length}:null,
   fixedInput:{correctAnswerCandidateNotDelivered:fraction(countBlocked(goldCorrect),goldCorrect.length),
    incorrectInputUnsupportedFinalDelivered:fraction(incorrect.filter(row=>row.delivered===true&&row.grade?.hallucination===true).length,incorrect.length),
    incorrectInputDeliveredFinalCorrect:fraction(incorrect.filter(row=>row.delivered===true&&row.grade?.correct===true).length,incorrect.length),
    incorrectInputDeliveredFinalFailure:fraction(incorrect.filter(row=>row.delivered===true&&row.grade?.correct!==true).length,incorrect.length),
    incorrectInputUngradeableFinalDelivered:incorrect.filter(row=>row.delivered===true&&row.grade?.parseable!==true).length}
  });
  const summary=result.byArm[arm],successes=summary.taskSuccess.numerator;
  const per=(value,denominator)=>value!==null&&denominator>0?value/denominator:null;
  for(const resource of ['inputTokens','outputTokens','cachedInputTokens','uncachedInputTokens','totalTokens']){
   summary[`${resource}PerCorrectDelivered`]=per(summary.usage[resource],successes);
   summary[`${resource}PerAttempt`]=per(summary.usage[resource],summary.attempts);
  }
  summary.callsPerCorrectDelivered=per(summary.calls.total,successes);
  summary.callsPerAttempt=per(summary.calls.total,summary.attempts);
  summary.resourceEfficiencyDenominators={correctDelivered:successes,attempts:summary.attempts,
   definition:'Full arm resource totals divided by correct delivered outputs in this scoring view, or by all attempts. Includes unsuccessful and blocked work. Zero denominator or missing total gives null.'};
 }
 result.definitions.falseBlock='The original falseBlockCorrectCandidateOnly is the answerable-only answer/uncertainty metric. allCorrectCandidateFalseBlock adds legitimate unknown/proposal answers. Only audited fullySupportedCandidateFalseBlock requires a complete supported basis.';
 result.definitions.fixedInput='goldCandidateCorrect labels the original injected answer/uncertainty. Final grade labels the saved output after any repair. An incorrect input repaired into a correct delivered output is not unsupported acceptance.';
 result.pairedResources=pairedResources(rows);
 const metrics=['taskSuccess','finalUnsupportedPerAll','finalUnsupportedPerDelivered','falseBlockCorrectCandidateOnly','allCorrectCandidateFalseBlock','correctUnknownNotDelivered','fullySupportedCandidateFalseBlock'];
 result.rateComparisons=Object.fromEntries(metrics.map(name=>{const b=result.byArm.baseline[name],s=result.byArm.strict[name];return [name,{baselineDenominator:b?.denominator??null,strictDenominator:s?.denominator??null,
  strictMinusBaselinePercentagePoints:b?.rate!==null&&b?.rate!==undefined&&s?.rate!==null&&s?.rate!==undefined?(s.rate-b.rate)*100:null}];}));
 return result;
}

function analyze(report,audit){
 if(report?.schema!==1||typeof report.identity!=='string'||!Array.isArray(report.rows))throw new TypeError('Invalid saved evaluation report');
 if(report.rows.some(row=>!['baseline','strict'].includes(row.arm)||!['e2e','fixed'].includes(row.lane)))throw new TypeError('Unknown arm or evaluation lane');
 const applied=applyAudit(report,audit),laneResults=rows=>Object.fromEntries(['e2e','fixed'].map(lane=>[lane,summarizeLane(rows.filter(row=>row.lane===lane),{audited:rows===applied.rows&&!!audit})]));
 return {schema:1,reportIdentity:report.identity,reportStatus:report.status||null,sourceUpdatedAt:report.updatedAt||null,model:report.model,reasoning:report.reasoning,
  startedAt:report.startedAt||null,design:report.design||null,rowCount:report.rows.length,audit:applied.metadata,
  interpretation:{eventRate:'Factual answer/uncertainty proxy on these synthetic cases, not a population hallucination estimate. Invalid output is ungradeable, not demonstrated safe.',
   uncertainty:'Wilson 95% intervals describe each numerator/denominator. For zero events, an exact one-sided 95% upper bound is also shown. Small, selected, dependent cases do not support broad population claims.',
   lanes:'e2e includes answer generation and verification. fixed measures behavior from injected correct/incorrect answer candidates. Never pool the two as one natural traffic rate.',
   tokens:'input includes cache; total=input+output; uncached=max(0,input-cache). Missing values stay null; known subtotals are labeled.',
   duration:'durationMs is concurrent end-to-end arm wall latency, including local processing; sums are not elapsed run time or model compute time.',
   review:'Audited semantic source review is distinct from raw exact matching and is not human blind review. Unreviewed rows retain raw grades.'},
  raw:laneResults(report.rows),audited:audit?laneResults(applied.rows):null,
  rows:report.rows.map((row,index)=>({caseId:row.caseId,lane:row.lane,arm:row.arm,goldCandidateCorrect:row.goldCandidateCorrect??null,candidateHash:hash(row.candidate),
   rawGrade:row.grade,effectiveGrade:applied.rows[index].grade,delivered:row.delivered,rawTechnicalError:row.technicalError??null,effectiveTechnicalError:applied.rows[index].technicalError??null,
   review:applied.rows[index].auditReview||null}))};
}

if(require.main===module){
 try{
  const options={};for(let index=2;index<process.argv.length;index+=2){const flag=process.argv[index];if(!['--report','--audit','--out'].includes(flag)||!process.argv[index+1])throw new Error('Usage: node grounding-eval-analysis.cjs --report report.json [--audit audit-overrides.json] [--out analysis.json]');options[flag.slice(2)]=path.resolve(process.argv[index+1]);}
  if(!options.report)throw new Error('--report is required');
  if(options.out&&[options.report,options.audit].filter(Boolean).some(source=>source.toLowerCase()===options.out.toLowerCase()))throw new Error('Output must not overwrite a source report or audit');
  const result=analyze(JSON.parse(fs.readFileSync(options.report,'utf8')),options.audit?JSON.parse(fs.readFileSync(options.audit,'utf8')):undefined);
  result.sources={report:options.report,audit:options.audit||null};
  const output=JSON.stringify(result,null,2)+'\n';if(options.out){fs.mkdirSync(path.dirname(options.out),{recursive:true});fs.writeFileSync(options.out,output);process.stdout.write(JSON.stringify({out:options.out,rows:result.rowCount,audit:result.audit})+'\n');}else process.stdout.write(output);
 }catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}

module.exports={analyze,applyAudit,wilson95,pairedResources,summarizeLane};
