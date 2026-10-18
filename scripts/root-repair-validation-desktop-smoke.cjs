'use strict';
// Independent UI -> IPC -> EngineClient -> formal engine-worker -> Agent test.
// Only model/OS/external transport boundaries are fixtures. Historical wait/run
// receipts are seeded; the old draft, new grant, repair, checks and local delivery
// are created through App. Never load a production workspace or attach a window.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const originalBody='# 修复验证报告\n\n## 已核实事实\n原稿中保留已核实事实。\n\n## 边界\n尚缺证据的边界需要明确。';
const repairedBody=originalBody.replace('原稿中保留已核实事实','修复稿中保留已核实事实，并明确尚缺证据的边界');
const authorizationNote='依据本次隔离验证要求，允许沿原稿和原交付执行一次修复及独立检查；失败后停止，最终由本人验收。';
const scenarios=['success','check_failure','generation_failure'];
function manifest(folder){const files={};function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else if(e.isFile())files[path.relative(folder,f)]=sha(f);}}walk(folder);return files;}
function assertLegacyRetention(job,baseline){
  const state=job.executionState.workEfficiency,grants=job.executionState.repairValidation,grant=grants.grants[grants.activeGrantId];
  // v3 separates permanent audit evidence from mutable run/stop projections.
  assert.deepEqual(grant.legacyWorkEfficiency,baseline,'the grant must retain the complete original ledger');
  const retained=[...(state.history||[])],equal=require('node:util').isDeepStrictEqual;
  for(const entry of baseline.history||[]){const i=retained.findIndex(row=>equal(row,entry));assert.ok(i>=0,'an original history entry was lost or rewritten');retained.splice(i,1);}
  for(const [key,value] of Object.entries(baseline.tried||{}))assert.deepEqual(state.tried?.[key],value,'an original tried entry was lost or rewritten: '+key);
  if(state.attempts!==undefined)assert.ok(Number.isSafeInteger(state.attempts)&&state.attempts>=0,'attempts must be a finite nonnegative integer when present');
  assert.equal(grant.knownFailures,1);assert.equal(grant.proof.knownCycles,1);
  return {legacySnapshotEqual:true,historyRetained:true,triedRetained:true,knownFailures:grant.knownFailures,...(state.attempts!==undefined?{attempts:state.attempts}:{})};
}
function legacy(a,job,task){
  const {hash}=require('../desktop/evidence-basis.cjs'),at=n=>new Date(Date.now()-3600000+n*1000).toISOString();
  const old={intent:require('../desktop/work-efficiency.cjs').intent(a,job),phase:'awaiting_change',waitBasis:'original-wait',lastFailure:{code:'PLAN_ALREADY_RECONCILED',taskId:task.id},blocker:{at:at(100)},history:[],tried:{}};
  job.executionState ||= {};job.executionState.workEfficiency=old;job.createdAt=task.createdAt=at(-20);job.status='blocked';job.nextRunAt=null;
  a.data.agentRuns=[{id:'prior-unknown',jobId:job.id,startedAt:at(-10),finishedAt:at(-8),steps:[{tool:'advance_task',args:{taskId:task.id},at:at(-9),errorCode:'MODEL_INVALID_RESPONSE'}]}];
  for(const [n,tool,errorCode] of [[0,'advance_task','MODEL_INVALID_RESPONSE'],[90,'plan_task','PLAN_ALREADY_RECONCILED']]){
    const id=tool+':'+task.id,args={taskId:task.id},step={tool,args,at:at(n+1),errorCode,strategyRecovery:{id}};
    const key=tool==='plan_task'?hash({tool,taskId:task.id}):hash({tool,args});
    old.history.push({id,basis:old.waitBasis,startedAt:at(n),finishedAt:at(n+5),outcome:'no_progress',actionKeys:[key],executedActions:[{tool,args}]});old.tried[old.waitBasis+':'+id]={at:at(n)};
    a.data.agentRuns.unshift({id:'legacy-'+n,jobId:job.id,startedAt:at(n),finishedAt:at(n+6),steps:[step]});
  }
  delete job.executionState.continuation;return old;
}

// Loaded only by the formal Worker from its temporary staged checkout.
async function create({Assistant,options}){
  const {threadId,isMainThread}=require('node:worker_threads');
  assert.equal(isMainThread,false);assert.ok(threadId>0);
  assert.ok(path.resolve(options.dir).startsWith(fs.realpathSync(os.tmpdir())+path.sep));
  fs.mkdirSync(options.dir,{recursive:true});
  assert.ok(fs.realpathSync(options.dir).startsWith(fs.realpathSync(os.tmpdir())+path.sep));
  const scenario=process.env.ROOT_REPAIR_SCENARIO,auditFile=process.env.ROOT_REPAIR_AUDIT;
  assert.ok(scenarios.includes(scenario));assert.ok(auditFile);
  const audit=fs.existsSync(auditFile)?JSON.parse(fs.readFileSync(auditFile)):{scenario,formalWorker:true,workerThreadIds:[],modelInputs:[],violations:[],realCalls:{model:0,platform:0,lark:0,network:0},forbiddenTransportAttempts:0};
  audit.workerThreadIds.push(threadId);const saveAudit=()=>fs.writeFileSync(auditFile,JSON.stringify(audit,null,2));
  const deny=()=>{audit.forbiddenTransportAttempts++;saveAudit();throw Error('External transport forbidden in isolated repair validation');};
  globalThis.fetch=deny;require('node:net').Socket.prototype.connect=deny;
  for(const name of ['spawn','exec','execFile','spawnSync','execSync','execFileSync'])require('node:child_process')[name]=deny;
  const subscription=require('../desktop/subscription.cjs');subscription.status=async()=>({available:false,loggedIn:false,message:'isolated fixture'});
  for(const name of ['chat','run','request'])if(typeof subscription[name]==='function')subscription[name]=deny;
  let seeding=false;
  const chat=async(_p,_k,m,o)=>{
    try{
      o.onUsage?.({inputTokens:100,outputTokens:20});const input=JSON.parse(m[1].content);
      const stage=o.stage==='task_work'?'generation':input.verificationPhase|| (m[0].content.includes('整体委托')?'goal':'final');
      audit.modelInputs.push({stage,role:o.role,seeding,context:input});saveAudit();
      assert.notEqual(o.stage,'planner','validation must directly continue the current text step');
      if(seeding)return o.role==='verify'?{passed:true,summary:'旧稿基线',gaps:[]}:{kind:'artifact',title:'修复验证报告',content:originalBody};
      const persisted=JSON.parse(fs.readFileSync(a.file)),job=persisted.delegations[0];
      const retention=assertLegacyRetention(job,audit.baseline.old);(audit.retentionChecks ||= []).push({stage,...retention});saveAudit();
      if(o.stage==='task_work'){
        assert.equal(audit.modelInputs.filter(r=>!r.seeding&&r.stage==='generation').length,1,'a second repair generation is forbidden');
        const grant=job.executionState.repairValidation.grants[job.executionState.repairValidation.activeGrantId];
        assert.ok(grant.claimedAttemptId,'claim must persist before model invocation');
        assert.equal(grant.executedBy,'supervisor');assert.equal(grant.authorizationRef.note,authorizationNote);
        assert.equal(input.revision.artifactId,audit.ids.originalId);assert.equal(input.revision.originalContent,originalBody);
        if(scenario==='generation_failure')throw Object.assign(Error('Controlled generation transport failure'),{expectedFixtureFailure:true});
        return {kind:'patch',edits:[{before:'原稿中保留已核实事实',after:'修复稿中保留已核实事实，并明确尚缺证据的边界'}]};
      }
      assert.equal(o.role,'verify');assert.equal(audit.modelInputs.filter(r=>!r.seeding&&r.stage===stage).length,1,'check phase cannot repeat: '+stage);
      assert.ok(m[1].content.includes('修复稿中保留已核实事实'),'checker must receive the generated current draft');
      if(scenario==='check_failure')return {passed:false,summary:'本次事实依据仍不足',gaps:['缺少发布负责人证据']};
      return {passed:true,summary:'已核对当前主稿、事实及原交付',gaps:[]};
    }catch(e){if(!e.expectedFixtureFailure)audit.violations.push(e.stack||e.message);saveAudit();throw e;}
  };
  const a=new Assistant({...options,chat,agentRequest:deny,connectorRequest:deny,officeRequest:deny,webRequest:deny,feedRequest:deny,platformRequest:deny});
  if(!a.data.delegations.length){
    seeding=true;const agent=require('../desktop/agent.cjs');
    await a.dispatch('saveProvider',{name:'isolated model transport',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:1,outputPrice:1});
    const output=path.join(options.dir,'fixture-delivery');fs.mkdirSync(output);a.data.agentSettings.outputFolder=output;
    const job=agent.buildJob(a,{goal:'修复原稿，保存原授权文件，独立检查后由用户验收',useOutputFolder:true,fileMode:'auto',autoAccept:false,maxActions:12});a.data.delegations.push(job);
    const source=agent.source(a,job,'input','已核实事实','已核实事实；尚缺证据必须明确边界。');
    const plan={key:'repair-report',title:'修复验证报告',criteria:'保留已核实事实并明确未知边界，保存文件后等待用户验收',sourceIds:[source.id],steps:[{key:'draft',title:'正文',kind:'draft'},{key:'file',title:'文件',kind:'external',tool:'write_file'}]};
    const {taskId}=await agent.act(a,job,'plan_task',plan),task=a.task(taskId);task.generationMode='single';
    await agent.act(a,job,'advance_task',{taskId});const originalId=task.primaryArtifactId;assert.ok(originalId);
    await agent.act(a,job,'revise_task',{taskId,artifactId:originalId,note:'保留原稿事实和章节，明确证据边界'});
    const old=legacy(a,job,task);a.activeAgentJob=job;const spend=require('../desktop/spend.cjs'),cost=spend.scope(a);cost.limitUSD=200;cost.spentUSD=157.1;spend.persist(a);a.activeAgentJob=null;
    audit.ids={jobId:job.id,taskId,originalId};audit.baseline={old:structuredClone(old),spend:structuredClone(cost),artifactCount:a.data.artifacts.length,output};
    const admission=require('../desktop/repair-validation.cjs').preview(a,job);assert.equal(admission.eligibility,true,JSON.stringify(admission));assert.equal(admission.proof.knownCycles,1);
    audit.admission=admission;a.data.runtime.onboarding={seenAt:new Date().toISOString(),version:2};a.save();seeding=false;
  }
  saveAudit();return a;
}

async function main(){
  const {spawnSync}=require('node:child_process'),{expect}=require('playwright/test');
  const runId=new Date().toISOString().replace(/[:.]/g,'-'),out=path.join(root,'artifacts/root-repair-validation-desktop',runId);
  fs.mkdirSync(out,{recursive:true});process.env.DESKTOP_TEST_REPORT_DIR=out;
  const {electron}=require('./desktop-test-support.cjs');
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'root-repair-validation-desktop-'))),staged=path.join(tmp,'app');
  const report={passed:false,layer:'UI + IPC + formal Worker + real Agent loop',formalWorker:false,sourceRoot:root,runId,realCalls:{model:0,platform:0,lark:0,network:0},scenarios:[],errors:[]};
  const hashes={desktop:manifest(path.join(root,'desktop')),src:manifest(path.join(root,'src'))};report.sourceHashes=hashes;report.testScriptSha256=sha(__filename);
  try{
    fs.mkdirSync(staged);for(const name of ['desktop','src','public','docs','index.html','package.json','vite.config.mjs'])if(fs.existsSync(path.join(root,name)))fs.cpSync(path.join(root,name),path.join(staged,name),{recursive:true});
    fs.mkdirSync(path.join(staged,'scripts'));
    for(const name of ['root-repair-validation-desktop-smoke.cjs','desktop-test-bootstrap.cjs','performance-worker-fixture.cjs'])fs.copyFileSync(path.join(root,'scripts',name),path.join(staged,'scripts',name));
    fs.symlinkSync(fs.realpathSync(path.join(root,'node_modules')),path.join(staged,'node_modules'),'dir');
    assert.deepEqual(manifest(path.join(staged,'desktop')),hashes.desktop);assert.deepEqual(manifest(path.join(staged,'src')),hashes.src);
    const build=spawnSync(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build'],{cwd:staged,encoding:'utf8'});fs.writeFileSync(path.join(out,'build.txt'),build.stdout+'\n'+build.stderr);assert.equal(build.status,0,build.stderr);
    for(const scenario of scenarios){
      const result={scenario,passed:false,checks:[],errors:[]};report.scenarios.push(result);
      const evidence=path.join(out,scenario),profile=path.join(tmp,scenario);fs.mkdirSync(evidence);fs.mkdirSync(profile);
      const auditFile=path.join(evidence,'transport-audit.json');let app,page;
      const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(typeof r.error==='string'?r.error:JSON.stringify(r.error));return r.data;},{action,input});
      const launch=async()=>{
        app=await electron.launch({args:[path.join(staged,'scripts/performance-worker-fixture.cjs')],cwd:staged,env:{...process.env,ASSISTANT_TEST_DATA_DIR:profile,ASSISTANT_ENGINE_WORKER:'1',ASSISTANT_ENGINE_FIXTURE:path.join(staged,'scripts/root-repair-validation-desktop-smoke.cjs'),ROOT_REPAIR_SCENARIO:scenario,ROOT_REPAIR_AUDIT:auditFile},timeout:60000});
        for(const stream of ['stdout','stderr'])app.process()[stream]?.on('data',chunk=>fs.appendFileSync(path.join(evidence,'electron-'+stream+'.txt'),chunk));
        page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));await page.getByRole('button',{name:/^Agent 委托/}).click();
      };
      const audit=()=>JSON.parse(fs.readFileSync(auditFile));
      const snapshot=()=>JSON.parse(fs.readFileSync(path.join(profile,'workspace/workspace.json')));
      const saveEvidence=async name=>{
        fs.writeFileSync(path.join(evidence,name+'-public-state.json'),JSON.stringify(await api('state'),null,2));
        fs.writeFileSync(path.join(evidence,name+'-ui.txt'),await page.locator('body').innerText());
        await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});
        const panel=page.getByRole('region',{name:'一次修复验证'});if(await panel.count())await panel.screenshot({path:path.join(evidence,name+'-grant-panel.png')});
      };
      try{
        await launch();result.formalWorker=audit().workerThreadIds.every(id=>id>0);assert.equal(result.formalWorker,true);
        const ids=audit().ids,region=page.getByRole('region',{name:'一次修复验证'}),button=region.getByRole('button',{name:'允许一次修复验证',exact:true});
        await expect(region).toBeVisible();await expect(button).toBeDisabled();
        assert.equal((await api('state')).delegations.find(j=>j.id===ids.jobId).repairValidation.candidate,true);
        await region.getByLabel('修复验证授权依据').fill(authorizationNote);await region.getByLabel('修复验证操作人').selectOption('supervisor');await expect(button).toBeEnabled();
        await saveEvidence('01-authorization-filled');await button.click();result.authorizationClicks=1;
        await expect.poll(async()=>(await api('state')).delegations.find(j=>j.id===ids.jobId).repairValidation.grant?.grantId).toBeTruthy();
        const granted=(await api('state')).delegations.find(j=>j.id===ids.jobId).repairValidation.grant;
        assert.equal(granted.claimedAttemptId,null);assert.equal(granted.outcome,null);assert.equal(granted.repairAttemptLimit,1);assert.equal(granted.knownFailures,1);
        result.retentionAtGrant=assertLegacyRetention(snapshot().delegations.find(j=>j.id===ids.jobId),audit().baseline.old);
        assert.equal(audit().modelInputs.filter(r=>!r.seeding).length,0,'authorization alone cannot generate');
        await expect(button).toHaveCount(0);await expect(region.getByRole('status')).toContainText('授权已记录');await saveEvidence('02-grant-saved');
        await page.getByRole('region',{name:'委托详情'}).getByRole('button',{name:'继续推进',exact:true}).click();
        await expect.poll(async()=>{const s=await api('state'),j=s.delegations.find(j=>j.id===ids.jobId);return s.operation?null:j.status;},{timeout:30000}).toBe(scenario==='success'?'review':'blocked');
        const state=await api('state'),job=state.delegations.find(j=>j.id===ids.jobId),grant=job.repairValidation.grant;
        assert.equal(grant.grantId,granted.grantId);assert.ok(grant.claimedAttemptId);assert.equal(grant.outcome,scenario==='success'?'passed':'failed');
        await expect(region.getByRole('status')).toContainText(scenario==='success'?'检查通过':'未通过');
        const calls=audit().modelInputs.filter(r=>!r.seeding);result.modelStages=calls.map(r=>r.stage);assert.equal(calls.filter(r=>r.stage==='generation').length,1);
        assert.deepEqual(result.modelStages,scenario==='success'?['generation','content','final','goal']:scenario==='check_failure'?['generation','content']:['generation']);
        const data=snapshot(),storedJob=data.delegations.find(j=>j.id===ids.jobId),task=data.tasks.find(t=>t.id===ids.taskId),store=storedJob.executionState.repairValidation,stored=store.grants[store.activeGrantId];
        assert.equal(Object.keys(store.grants).length,1);assert.equal(stored.executedBy,'supervisor');assert.equal(stored.authorizationRef.note,authorizationNote);assert.equal(stored.proof.complete,false);
        assert.equal(task.acceptedAt,undefined);assert.equal(storedJob.autoAccept,false);
        result.retentionAfterRun=assertLegacyRetention(storedJob,audit().baseline.old);
        assert.equal(data.artifacts.find(r=>r.id===ids.originalId).content,originalBody);
        assert.equal(data.artifacts.length,audit().baseline.artifactCount+(scenario==='generation_failure'?0:1));
        const journal=require(path.join(staged,'desktop/work-journal.cjs')).read({dir:path.join(profile,'workspace'),data});
        const events=journal.events.filter(e=>e.type==='repair_validation');assert.equal(events.filter(e=>e.payload.kind==='grant').length,1);assert.equal(events.filter(e=>e.payload.kind==='claim').length,1);
        result.events=events;result.publicGrant=grant;result.grant=stored;result.run=data.agentRuns.find(r=>!r.id.startsWith('legacy-')&&r.id!=='prior-unknown');
        if(scenario==='success'){
          assert.equal(task.status,'review');assert.equal(data.artifacts.find(r=>r.id===task.primaryArtifactId).content,repairedBody);
          assert.deepEqual(result.run.steps.map(s=>s.tool).slice(0,4),['advance_task','verify_content','write_file','advance_task']);
          assert.equal(stored.committedCheckRef.phase,'final');assert.ok(fs.readdirSync(audit().baseline.output).some(name=>fs.readFileSync(path.join(audit().baseline.output,name),'utf8').includes(repairedBody)));
        }else assert.equal(stored.outcome,'failed');
        const cost=state.spendStatus.scopes.find(s=>s.key==='job:'+ids.jobId);assert.equal(cost.limitUSD,200);assert.ok(cost.spentUSD>=157.1);result.spend=cost;
        await saveEvidence('03-result');await app.close();app=null;
        await launch();const after=(await api('state')).delegations.find(j=>j.id===ids.jobId);assert.deepEqual(after.repairValidation.grant,grant);
        await expect(page.getByRole('button',{name:'允许一次修复验证',exact:true})).toHaveCount(0);
        if(scenario!=='success'){
          const before=audit().modelInputs.length;
          // Retry through UI, then the actual worker command as a guard probe.
          const retry=page.getByRole('region',{name:'委托详情'}).getByRole('button',{name:'继续推进',exact:true});
          if(await retry.count())await retry.click();
          try{await api('agentRun',{id:ids.jobId});}catch(e){result.retryGuard=e.message;}
          await expect.poll(async()=>!!(await api('state')).operation).toBe(false);
          assert.equal(audit().modelInputs.length,before);assert.equal((await api('state')).delegations.find(j=>j.id===ids.jobId).status,'blocked');
          assert.deepEqual((await api('state')).delegations.find(j=>j.id===ids.jobId).repairValidation.grant,grant);
        }
        const restartedData=snapshot(),restartedLog=require(path.join(staged,'desktop/work-journal.cjs')).read({dir:path.join(profile,'workspace'),data:restartedData});
        result.retentionAfterRestart=assertLegacyRetention(restartedData.delegations.find(j=>j.id===ids.jobId),audit().baseline.old);
        assert.equal(restartedLog.events.filter(e=>e.type==='repair_validation'&&e.payload.kind==='claim').length,1);
        assert.equal(restartedLog.events.filter(e=>e.type==='repair_validation'&&e.payload.kind==='grant').length,1);
        assert.equal(restartedData.artifacts.length,data.artifacts.length);
        await saveEvidence('04-cold-restart');assert.deepEqual(audit().violations,[]);assert.equal(audit().forbiddenTransportAttempts,0);
        for(const name of ['workspace.json','work-journal.json','spend-ledger.json'])if(fs.existsSync(path.join(profile,'workspace',name)))fs.copyFileSync(path.join(profile,'workspace',name),path.join(evidence,name));
        fs.cpSync(audit().baseline.output,path.join(evidence,'delivery-files'),{recursive:true});
        result.checks=['one UI supervisor authorization; grant and claim durably journaled','formal Worker executes generation/checks with exact per-phase counts','public grant matches persisted outcome','cold Worker restart retains grant without second repair','complete legacy grant snapshot and live history/tried/known failures retained; attempts valid','original draft, spend limit and user acceptance retained'];result.passed=result.errors.length===0;
      }catch(e){result.errors.push(e.stack||e.message);if(page&&!page.isClosed())await saveEvidence('failure').catch(()=>{});}
      finally{if(app)await app.close().catch(e=>result.errors.push(e.message));fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(result,null,2));}
      console.log(JSON.stringify({scenario,passed:result.passed,evidence,errors:result.errors}));
    }
    report.formalWorker=report.scenarios.every(s=>s.formalWorker);report.passed=report.scenarios.every(s=>s.passed);
  }catch(e){report.errors.push(e.stack||e.message);}
  finally{
    if(process.argv.includes('--with-delivery')){
      const delivery=spawnSync(process.execPath,[path.join(root,'scripts/root-delivery-desktop-smoke.cjs')],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
      fs.writeFileSync(path.join(out,'delivery-process.log'),(delivery.stdout||'')+'\n'+(delivery.stderr||''));
      const row=(delivery.stdout||'').split('\n').filter(s=>s.startsWith('{')).map(s=>{try{return JSON.parse(s);}catch{return null;}}).find(r=>r?.evidence);
      const target=path.join(root,'artifacts/root-delivery-desktop',runId);
      if(row?.evidence&&fs.existsSync(row.evidence)){fs.cpSync(row.evidence,target,{recursive:true});const p=path.join(target,'report.json'),d=JSON.parse(fs.readFileSync(p));fs.copyFileSync(p,path.join(target,'original-report.json'));d.formalWorker=JSON.parse(fs.readFileSync(path.join(target,'transport-audit.json'))).workerThreadId>0;d.realCalls={model:0,platform:0,lark:0,network:0};fs.writeFileSync(p,JSON.stringify(d,null,2));fs.writeFileSync(path.join(target,'artifact-manifest.json'),JSON.stringify(manifest(target),null,2));report.delivery={passed:delivery.status===0&&d.passed,evidence:target,sourceHashes:d.sourceHashes};report.sameSourceForBothFlows=JSON.stringify(d.sourceHashes)===JSON.stringify(hashes);}
      else report.delivery={passed:false,error:delivery.stderr||delivery.error?.message||'missing delivery report'};
      report.passed=report.passed&&report.delivery.passed;
    }
    report.sourceChangedDuringRun=JSON.stringify(hashes)!==JSON.stringify({desktop:manifest(path.join(root,'desktop')),src:manifest(path.join(root,'src'))});
    if(report.sourceChangedDuringRun||report.sameSourceForBothFlows===false){report.passed=false;report.errors.push('SOURCE_CHANGED_DURING_VALIDATION: rerun both flows against one stable source snapshot');}
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,'artifact-manifest.json'),JSON.stringify(manifest(out),null,2));
    fs.writeFileSync(path.join(root,'artifacts/root-repair-validation-desktop/latest.json'),JSON.stringify({runId,report:path.join(out,'report.json'),passed:report.passed},null,2));
    console.log(JSON.stringify({passed:report.passed,evidence:out,sourceChangedDuringRun:report.sourceChangedDuringRun}));fs.rmSync(tmp,{recursive:true,force:true});
  }
  if(!report.passed)process.exitCode=1;
}
module.exports={create};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
