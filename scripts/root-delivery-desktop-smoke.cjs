'use strict';
// Full-chain desktop test: Electron -> IPC -> EngineClient -> production
// engine-worker.cjs -> Assistant -> real Agent loop. Only external transports
// are synthetic. Build/copy/report/userData all live under one temporary root;
// the source checkout (including desktop/src and any existing dist) is read-only.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {expect}=require('playwright/test');
const root=path.resolve(__dirname,'..');
const upgrade=process.env.UPGRADE_RECOVERY_TEST==='1';
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'root-delivery-desktop-')));
const staged=path.join(dir,'app'),profile=path.join(dir,'profile'),evidence=path.join(dir,'evidence');
for(const p of [staged,profile,evidence])fs.mkdirSync(p,{recursive:true});
process.env.DESKTOP_TEST_REPORT_DIR=evidence;
const {electron}=require('./desktop-test-support.cjs');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function manifest(folder){
  const result={};const walk=p=>{for(const entry of fs.readdirSync(p,{withFileTypes:true})){const file=path.join(p,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile())result[path.relative(folder,file)]=sha(file);}};walk(folder);return result;
}
let app,reopened;
const report={layer:'real Electron + production Worker + full controlled Agent loop',passed:false,realNetworkCalls:0,realModelCalls:0,sourceRoot:root,checks:[],errors:[]};
async function main(){
  try{
    const hashes={desktop:manifest(path.join(root,'desktop')),src:manifest(path.join(root,'src'))};
    for(const name of ['desktop','src','public','docs','index.html','package.json','vite.config.mjs'])if(fs.existsSync(path.join(root,name)))fs.cpSync(path.join(root,name),path.join(staged,name),{recursive:true});
    fs.mkdirSync(path.join(staged,'scripts'));fs.mkdirSync(path.join(staged,'tests/helpers'),{recursive:true});
    for(const name of ['desktop-test-bootstrap.cjs','root-delivery-fixture.cjs','performance-worker-fixture.cjs'])fs.copyFileSync(path.join(root,'scripts',name),path.join(staged,'scripts',name));
    fs.copyFileSync(path.join(root,'tests/helpers/platform-fixture.cjs'),path.join(staged,'tests/helpers/platform-fixture.cjs'));
    fs.symlinkSync(fs.realpathSync(path.join(root,'node_modules')),path.join(staged,'node_modules'),'dir');
    assert.deepEqual(manifest(path.join(staged,'desktop')),hashes.desktop);assert.deepEqual(manifest(path.join(staged,'src')),hashes.src);
    report.sourceHashes=hashes;
    const build=spawnSync(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build'],{cwd:staged,encoding:'utf8'});
    fs.writeFileSync(path.join(evidence,'build.txt'),build.stdout+'\n'+build.stderr);assert.equal(build.status,0,'isolated renderer build failed: '+build.stderr);
    const auditFile=path.join(evidence,'transport-audit.json'),worker=path.join(dir,'worker-fixture.cjs');
    fs.writeFileSync(worker,`'use strict';
exports.create=async({Assistant,options})=>{
  const deny=()=>{throw Error('Real external transport forbidden in desktop root delivery');};
  globalThis.fetch=deny;require('node:net').Socket.prototype.connect=deny;
  require('node:child_process').spawn=deny;require('node:child_process').execFile=deny;
  const subscription=require(${JSON.stringify(path.join(staged,'desktop/subscription.cjs'))});
  subscription.status=async()=>({available:false,loggedIn:false,message:'isolated transport fixture'});
  for(const key of ['chat','run','request'])if(typeof subscription[key]==='function')subscription[key]=deny;
  const f=await require(${JSON.stringify(path.join(staged,'scripts/root-delivery-fixture.cjs'))}).setup({Assistant,options,reportFile:${JSON.stringify(auditFile)},scenario:${JSON.stringify(upgrade?'input_upgrade':'success')}});
  if(${upgrade}){await require(${JSON.stringify(path.join(staged,'desktop/agent.cjs'))}).run(f.a,f.job.id);if(f.job.status!=='blocked')throw Error('Expected persisted old input failure');f.reopen();await f.a.dispatch('stewardshipPause',{});f.saveAudit();}
  return f.a;
};\n`);
    app=await electron.launch({args:[path.join(staged,'scripts/performance-worker-fixture.cjs')],cwd:staged,env:{...process.env,ASSISTANT_TEST_DATA_DIR:profile,ASSISTANT_ENGINE_WORKER:'1',ASSISTANT_ENGINE_FIXTURE:worker},timeout:60000});
    for(const key of ['stdout','stderr'])app.process()[key]?.on('data',chunk=>fs.appendFileSync(path.join(evidence,'electron-'+key+'.txt'),chunk));
    const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));
    const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
    const baseline=JSON.parse(fs.readFileSync(auditFile));assert.ok(baseline.workerThreadId>0,'fixture must execute in the formal Worker');
    const id=baseline.ids.jobId;const callsBefore=baseline.modelInputs.length;
    const initialRunId=(await api('state')).agentRuns.find(r=>r.jobId===id)?.id;
    if(upgrade){
      const before=await api('state');assert.equal(before.delegations.find(j=>j.id===id).status,'blocked');
      assert.equal(JSON.parse(fs.readFileSync(auditFile)).events.filter(e=>e.kind==='cold_workspace_loaded').length,1);
      assert.equal(JSON.parse(fs.readFileSync(auditFile)).modelInputs.length,callsBefore);
      await api('stewardshipResume');
      report.checks.push('persisted old input-size failure survives cold Assistant load; UI global resume drives automatic preflight and recovery');
    }else{
    await api('agentPause',{id});await assert.rejects(api('agentRun',{id}),/暂停/);
    assert.equal(JSON.parse(fs.readFileSync(auditFile)).modelInputs.length,callsBefore,'paused guard must stop before any model call');
    report.checks.push('real Worker pause guard rejects dispatch before model/platform calls');
    await api('agentResume',{id});await api('agentRun',{id});
    }
    await expect.poll(async()=>{const s=await api('state'),job=s.delegations.find(j=>j.id===id);if(upgrade&&!s.operation&&job?.status==='blocked'&&s.agentRuns.find(r=>r.jobId===id)?.id===initialRunId)return null;if(!s.operation&&['blocked','retry','approval','needs_input'].includes(job?.status))throw Error(JSON.stringify({status:job?.status,summary:job?.summary,error:job?.lastError,violations:JSON.parse(fs.readFileSync(auditFile)).violations}));return s.operation?null:job?.status;},{timeout:45000}).toBe('review');
    const state=await api('state');assert.equal(state.tasks.find(t=>t.id===baseline.ids.taskId).status,'review');
    await page.getByRole('button',{name:/^Agent 委托/}).click();
    await expect(page.getByRole('region',{name:'实际推进状态'})).toContainText('等待验收');
    await page.reload();await page.getByRole('button',{name:/^Agent 委托/}).click();
    assert.equal((await api('state')).delegations.find(j=>j.id===id).status,'review');
    await page.screenshot({path:path.join(evidence,'review.png'),fullPage:true});
    await app.close();app=null;
    // Cold read of the persisted isolated workspace, with every transport denied.
    const common=require(path.join(staged,'scripts/root-delivery-fixture.cjs'));
    const deny=async()=>{throw Error('No transport allowed during restart verification');};
    const {Assistant}=require(path.join(staged,'desktop/core.cjs'));
    reopened=new Assistant({dir:path.join(profile,'workspace'),chat:deny,connectorRequest:deny,platformRequest:deny,webRequest:deny});
    const audit=JSON.parse(fs.readFileSync(auditFile)),job=reopened.data.delegations.find(j=>j.id===id),task=reopened.task(audit.ids.taskId);
    const f={a:reopened,job,task,audit,remote:audit.remote,baseline:audit.baseline,old:reopened.data.artifacts.find(r=>r.id===audit.ids.oldId),unrelated:{id:audit.ids.unrelatedId}};
    report.result=common.assertComplete(f);if(upgrade){const attempt=job.executionState?.inputRecovery?.attempts?.[require(path.join(staged,'desktop/input-recovery.cjs')).POLICY_VERSION];assert.equal(attempt?.status,'ready');report.upgradeRecovery=attempt;}assert.deepEqual(report.errors,[]);
    report.checks.push('19 actual platform snapshots associated by plan_task','six read_context batches visible in subsequent model requests','current original primary revised and independently verified','one same-target Lark update plus actual readback','review survives renderer reload and cold workspace load; no autoAccept','historical spend and unknown reserve retained');
    // Source edits by concurrent implementers are recorded, never overwritten.
    report.sourceChangedDuringRun=JSON.stringify(manifest(path.join(root,'desktop')))!==JSON.stringify(hashes.desktop)||JSON.stringify(manifest(path.join(root,'src')))!==JSON.stringify(hashes.src);
    report.passed=true;
  }catch(error){
    report.errors.push(error.stack||error.message);throw error;
  }finally{
    if(app)await app.close().catch(e=>report.errors.push(e.message));
    if(reopened)require(path.join(staged,'scripts/root-delivery-fixture.cjs')).dispose(reopened);
    fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:report.passed,layer:report.layer,evidence,checks:report.checks,result:report.result}));
    // Retain isolated evidence, including failures, for independent inspection.
    fs.rmSync(staged,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
