#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const gate=require('./system-release-gate.cjs'),engineering=require('./engineering-check.cjs');
const root=path.resolve(__dirname,'..');
function need(value,message){if(!value)throw Error(message);}
function options(args) {
  const result={};
  for(let i=0;i<args.length;i++) {
    const key=args[i];need(/^--[a-z-]+$/.test(key),'INVALID_OPTION: '+key);need(!(key.slice(2) in result),'DUPLICATE_OPTION: '+key);
    if(['--zip-only','--clean'].includes(key))result[key.slice(2)]=true;
    else {need(args[i+1]&&!args[i+1].startsWith('--'),'MISSING_OPTION_VALUE: '+key);result[key.slice(2)]=args[++i];}
  }
  return result;
}
const permitted={check:['definition','source','clean'],plan:['history-root','fixture-root','out','definition'],freeze:['definition','source','out'],
  run:['gate','only','metrics'],build:['gate','metrics'],'check-release':['gate','mapping','implementation-review'],
  archive:['gate','mapping','implementation-review','out','zip-only'],verify:['gate','mapping','implementation-review','archive','out']};
function parse(argv) {
  need(!process.env.XINGZHI_PACKAGE_OUT&&!process.env.XINGZHI_PACKAGE_REPORT,'LEGACY_OUTPUT_OVERRIDE: use release.cjs with --gate and explicit --out; old package paths are not trusted');
  let [command,...rest]=argv;
  if(command==='build'&&rest.includes('--archives-only')){command='archive';rest=rest.filter(v=>v!=='--archives-only');}
  need(permitted[command],'USAGE: release.cjs check|plan|freeze|run|build|check-release|archive|verify');
  const o=options(rest);need(Object.keys(o).every(k=>permitted[command].includes(k)),`UNSUPPORTED_OPTION: ${command}`);
  for(const key of (command==='check'||command==='freeze'?['definition']:['run','build','check-release','archive','verify'].includes(command)?['gate']:[]))need(o[key],`MISSING_${key.toUpperCase()}: ${command} requires --${key}; no unverified fallback`);
  return {command,o};
}
function metricsLocation(f,o){return o.metrics || f.identity.metricsDir || null;}
async function runGroup(o,group) {
  need(gate.GROUPS.includes(group),'UNKNOWN_GROUP: '+group);
  const startedAt=new Date().toISOString(),attemptId=crypto.randomUUID();
  let dir,f,metricsDir=o.metrics||null,result,error,metricError;
  // Metrics is observational. Only a newly produced receipt belongs to this
  // attempt; an early refusal must never reimport the previous green run.
  try {
    dir=fs.realpathSync(o.gate);f=gate.loadFreeze(dir);metricsDir=metricsLocation(f,o);
    gate.assertEngineeringAdmission(f);
    result=await gate.run({dir,group,runId:attemptId,bundle:group==='build'?path.join(f.source,f.plan.build.output):undefined});
    need(result.runId===attemptId,'RUN_OWNERSHIP_MISMATCH');
    if(group==='build')result.package=gate.packageId({dir,bundle:path.join(f.source,f.plan.build.output)});
  }catch(e){error=e;}
  if(metricsDir) {
    try {
      const metrics=require('./iteration-metrics.cjs');
      if(f){const actual=gate.prospectiveRealpath(path.resolve(metricsDir));gate.outsideInputs(f.source,actual);need(!gate.inside(dir,actual)&&!gate.inside(actual,dir),'METRICS_OUTPUT_OVERLAP: ledger cannot overlap gate');
        const iterationId=f.identity.iterationId||f.freezeDigest;
        if(fs.existsSync(path.join(metricsDir,'meta.json')))need(metrics.report({dir:metricsDir}).iterationId===iterationId,'METRICS_ITERATION_MISMATCH');
        else metrics.init({dir:metricsDir,iterationId,actor:'release-runner',occurredAt:f.frozenAt});}
      const receipt=dir&&path.join(dir,'runs',group,attemptId,'receipt.json'),owned=receipt&&fs.existsSync(receipt);
      const ownReceipt=owned?gate.unseal(dir,receipt):null;
      if(ownReceipt)need(ownReceipt.runId===attemptId&&ownReceipt.group===group&&ownReceipt.freezeDigest===f.freezeDigest,'RUN_OWNERSHIP_MISMATCH');
      let imported=false;
      if(owned)try{metrics.importRun({dir:metricsDir,gateDir:dir,group,runId:attemptId,actor:'release-runner'});imported=true;}catch(e){if(e.code!=='METRICS_GATE_NO_COMMAND')throw e;}
      if(!imported || error&&ownReceipt?.status==='passed'){const endedAt=new Date().toISOString();const evidence=owned?[{path:receipt,sha256:gate.fileHash(receipt)}]:[];metrics.record({dir:metricsDir,event:{eventId:'preflight-'+attemptId,type:'attempt_failed',occurredAt:endedAt,actor:'release-runner',origin:'observed',payload:{attemptId,phase:'verification',command:['release','run',group],classification:'preflight_rejection',startedAt,endedAt,errorCode:error?.code||null,error:error?.message||'runner rejected before launching a command',candidate:f?.sourceDigest||null},evidence}});}
    }catch(e){metricError=e;}
  }
  if(error){if(metricError)error.message+='; metrics recording failed: '+metricError.message;throw error;}
  if(metricError)throw Error('METRICS_FAILED: gate receipt preserved; '+metricError.message);
  return {...result,metrics:metricsDir||'not_configured'};
}
async function main(argv) {
  const {command,o}=parse(argv);
  if(command==='check')return engineering.check({source:o.source||root,definitionFile:o.definition,requireClean:!!o.clean});
  if(command==='plan') {
    const plan=require('./release-plan.cjs').generate({historyRoot:o['history-root'],fixtureRoot:o['fixture-root'],...(o.definition?{requirements:engineering.definition(o.definition).requirements}:{})});
    if(o.out)fs.writeFileSync(path.resolve(o.out),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
    return plan;
  }
  if(command==='freeze') {
    const d=engineering.definition(o.definition),admission=engineering.check({source:o.source||root,definitionFile:o.definition,requireClean:true});
    need(admission.passed,'ENGINEERING_ADMISSION_FAILED: '+JSON.stringify(admission.rules.filter(r=>r.status!=='passed')));
    need(o.out,'MISSING_OUT');
    return gate.freeze({source:o.source||root,dir:o.out,design:d.design,designReview:d.designReview,planFile:d.verificationPlan});
  }
  if(command==='run'||command==='build')return runGroup(o,command==='build'?'build':o.only);
  const frozen=gate.loadFreeze(o.gate);gate.assertEngineeringAdmission(frozen);
  const args={dir:o.gate,mappingFile:o.mapping,implementationReview:o['implementation-review']};
  if(command==='check-release'){
    const result=gate.check(args),metricsDir=metricsLocation(frozen,o);
    if(metricsDir){
      const actual=gate.prospectiveRealpath(path.resolve(metricsDir)),gateDir=fs.realpathSync(o.gate);
      gate.outsideInputs(frozen.source,actual);need(!gate.inside(gateDir,actual)&&!gate.inside(actual,gateDir),'METRICS_OUTPUT_OVERLAP');
      const metrics=require('./iteration-metrics.cjs');
      need(metrics.report({dir:metricsDir}).iterationId===frozen.identity.iterationId,'METRICS_ITERATION_MISMATCH');
      result.metricsAcceptance=metrics.acceptCandidate({dir:metricsDir,gateDir,mappingFile:o.mapping,implementationReview:o['implementation-review'],actor:'release-runner'}).event.eventId;
    }
    return result;
  }
  need(o.mapping&&o['implementation-review'],'MISSING_REVIEW_CLOSURE: --mapping and --implementation-review required');
  if(command==='archive'){need(o.out,'MISSING_OUT');return require('./release-archive.cjs').archive({...args,out:o.out,zipOnly:!!o['zip-only']});}
  need(o.archive&&o.out,'MISSING_ARCHIVE_OR_OUT');
  return require('./release-archive.cjs').verify({...args,archiveDir:o.archive,out:o.out});
}
function cli(argv) {main(argv).then(result=>{console.log(JSON.stringify(result,null,2));if(result.passed===false)process.exitCode=1;}).catch(error=>{console.error(JSON.stringify({passed:false,error:error.message,productionDelivery:'not_verified'}));process.exitCode=1;});}
module.exports={parse,options,main,runGroup,cli};
if(require.main===module)cli(process.argv.slice(2));
