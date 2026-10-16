const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const health=require('../desktop/health.cjs');
function setup(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-health-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>{throw new Error('体检不得调用模型');},agentRequest:async()=>{throw new Error('体检不得联网');}});
  a.data.projects=[{id:'p',name:'本项目'},{id:'q',name:'其他项目'}];
  a.data.stewardship.timeZone='Asia/Shanghai';
  return a;
}
function job(a,patch={}) {const value={id:'job',projectId:'p',title:'发布资料',status:'ready',taskIds:[],sourceIds:[],folderIds:[],maxCalls:30,callsUsed:0,...patch};a.data.delegations.push(value);return value;}
const task=(a,patch={})=>Object.assign(a.createTask({title:'检查资料',criteria:'来源准确'}),patch);
const codes=value=>value.findings.map(row=>row.code);
const at=(value,fn)=>{const old=Date.now;Date.now=()=>Date.parse(value);try{return fn();}finally{Date.now=old;}};

test('Health reads state without saving, decrypting, creating files, calling models or network',t=>{
  const a=setup(t);job(a);task(a);a.save=()=>{throw new Error('禁止保存');};a.vault.open=()=>{throw new Error('禁止读取凭据');};const before=JSON.stringify(a.data),files=fs.readdirSync(a.dir);
  const report=health.snapshot(a);assert.equal(report.modelCalls,0);assert.equal(report.networkRequests,0);assert.equal(report.tasks,undefined);assert.equal(JSON.stringify(a.data),before);assert.deepEqual(fs.readdirSync(a.dir),files);assert.ok(report.limitations.some(v=>v.includes('完整诊断')));
});
test('Fresh install distinguishes missing roles from untested network',t=>{
  const a=setup(t),r=health.snapshot(a);for(const role of ['organize','execute','verify'])assert.ok(codes(r).includes('role_'+role));assert.ok(codes(r).includes('network_unverified'));assert.ok(!r.checks.some(c=>c.status==='passed'));
});
test('Configured models remain unverified until their existing connection test is run',t=>{
  const a=setup(t);a.data.providers=[{id:'model',type:'codex',model:'gpt-fixture'}];a.data.settings.roles={organize:'model',execute:'model',verify:'model'};
  let r=health.snapshot(a);assert.ok(codes(r).includes('models_unverified'));assert.ok(!codes(r).some(c=>c.startsWith('role_')));a.data.providers[0].model='';r=health.snapshot(a);assert.ok(codes(r).includes('provider_execute'));
});
test('Project scope includes inherited tasks and global blockers without another project content or routes',t=>{
  const a=setup(t);job(a,{id:'pjob'});job(a,{id:'qjob',projectId:'q',status:'blocked',title:'FOREIGN_JOB'});task(a,{projectId:'q',status:'blocked',title:'FOREIGN_TASK'});task(a,{agentJobId:'pjob',status:'blocked'});a.data.connectors=[{id:'qconn',projectId:'q',name:'FOREIGN_CONNECTOR',health:'auth'}];
  const r=health.snapshot(a,{projectId:'p'});assert.ok(codes(r).includes('task_blocked'));assert.ok(!JSON.stringify(r).includes('FOREIGN'));assert.ok(!r.findings.some(f=>f.route.projectId==='q'));assert.ok(codes(r).includes('role_execute'));
});
test('Independent filter excludes projects and malformed project input is rejected',t=>{
  const a=setup(t);job(a,{status:'blocked'});task(a,{status:'blocked',title:'独立事项'});task(a,{projectId:'q',status:'blocked',title:'FOREIGN_TASK'});
  const r=health.snapshot(a,{projectId:'@independent'});assert.ok(codes(r).includes('task_blocked'));assert.ok(!codes(r).includes('job_blocked'));assert.ok(!JSON.stringify(r).includes('FOREIGN'));
  for(const input of [null,[],{projectId:3},{projectId:'missing'}])assert.throws(()=>health.snapshot(a,input));
});
test('Mismatched task links never navigate into a foreign project',t=>{
  const a=setup(t);job(a,{id:'qjob',projectId:'q'});const t1=task(a,{projectId:'p',agentJobId:'qjob',needsReplan:'changed'});
  const r=health.snapshot(a,{projectId:'p'});assert.ok(codes(r).includes('task_link'));assert.ok(!r.findings.some(f=>f.route.projectId==='q'||f.route.jobId==='qjob'));assert.equal(r.findings.find(f=>f.code==='task_replan').route.taskId,t1.id);
});
test('Intentional pauses and work windows are informational, never red errors',t=>{
  const a=setup(t);a.data.stewardship.paused=true;job(a,{status:'paused'});a.data.folders=[{id:'folder',name:'暂停目录',path:a.dir,enabled:false,projectId:'p',health:'paused'}];
  const r=health.snapshot(a);for(const code of ['global_paused','job_paused','folder_paused'])assert.equal(r.findings.find(f=>f.code===code).severity,'info');assert.equal(r.counts.error,0);
  a.data.stewardship.paused=false;a.data.stewardship.window={enabled:true,start:'09:00',end:'18:00'};at('2026-10-02T00:00:00Z',()=>assert.equal(health.snapshot(a).findings.find(f=>f.code==='global_window').severity,'info'));
});
test('Workspace and delegation budgets report actual quota without consuming or resetting it',t=>{
  const a=setup(t);job(a,{status:'limited',callsUsed:7,maxCalls:7});a.data.stewardship.dailyCallLimit=3;a.data.stewardship.usage.days['2026-10-02']=3;
  at('2026-10-02T01:00:00Z',()=>{const before=JSON.stringify(a.data);const r=health.snapshot(a);assert.ok(!codes(r).includes('global_budget'));assert.ok(codes(r).includes('job_limit'));assert.equal(JSON.stringify(a.data),before);});
});
test('Unknown external results route to owning jobs even when pending pointer is missing',t=>{
  const a=setup(t);job(a);a.data.agentActions=[{id:'unknown',jobId:'job',status:'uncertain',content:'PRIVATE_BODY',target:'/private/file'},{id:'approve',jobId:'job',status:'pending'},{id:'running',jobId:'job',status:'running'}];
  const r=health.snapshot(a);assert.equal(r.findings.filter(f=>f.code==='external_uncertain').length,2);assert.equal(r.findings.find(f=>f.code==='external_approval').severity,'info');assert.ok(!JSON.stringify(r).includes('PRIVATE_BODY'));assert.equal(r.findings.find(f=>f.route.actionId==='unknown').route.jobId,'job');
  a.operation={label:'unrelated work'};assert.equal(health.snapshot(a).findings.filter(f=>f.code==='external_uncertain').length,2);a.activeAgentJob=a.data.delegations[0];a.activeAgentJob.pendingActionId='running';assert.equal(health.snapshot(a).findings.filter(f=>f.code==='external_uncertain').length,1);
});
test('Orphan write receipts are visible in whole workspace but not accidentally attributed to a project',t=>{
  const a=setup(t);a.data.agentActions=[{id:'orphan',jobId:'missing',status:'uncertain'}];assert.ok(codes(health.snapshot(a)).includes('external_uncertain'));assert.ok(!codes(health.snapshot(a,{projectId:'p'})).includes('external_uncertain'));
});
test('Output folder existence never claims the folder can be written or delivery was verified',t=>{
  const a=setup(t);job(a,{outputFolder:a.dir});const r=health.snapshot(a);assert.ok(codes(r).includes('output_write_unverified'));assert.equal(r.findings.find(f=>f.code==='output_write_unverified').severity,'unknown');assert.ok(!JSON.stringify(r).includes(a.dir));
});
test('Missing and symlink-replaced output directories are detected without following content',t=>{
  const a=setup(t),real=path.join(a.dir,'out'),link=path.join(a.dir,'link');fs.mkdirSync(real);fs.symlinkSync(real,link);const j=job(a,{outputFolder:link});assert.ok(codes(health.snapshot(a)).includes('output_folder'));j.outputFolder=path.join(a.dir,'missing');assert.ok(codes(health.snapshot(a)).includes('output_folder'));j.outputFolder=real;assert.ok(!codes(health.snapshot(a)).includes('output_folder'));
});
test('Undelivered file steps with missing output permission are actionable',t=>{
  const a=setup(t);job(a,{fileMode:'off'});task(a,{agentJobId:'job',projectId:'p',steps:[{id:'step',kind:'external',tool:'write_file',done:false}]});const r=health.snapshot(a);assert.ok(codes(r).includes('output_folder'));assert.ok(codes(r).includes('file_permission'));
});
test('Folder errors, partial scans, no success and old success have distinct diagnoses',t=>{
  const a=setup(t);a.data.folders=[{id:'failed',name:'出错目录',path:a.dir,enabled:true,health:'error',error:'PRIVATE_ERROR'},{id:'partial',name:'不完整目录',path:a.dir,enabled:true,health:'attention',stats:{complete:false}},{id:'old',name:'旧目录',path:a.dir,enabled:true,health:'healthy',lastSuccessAt:'2000-01-01T00:00:00Z'}];
  const r=health.snapshot(a);for(const c of ['folder_failed','folder_partial','folder_unchecked','folder_stale'])assert.ok(codes(r).includes(c));assert.ok(!JSON.stringify(r).includes('PRIVATE_ERROR'));
});
test('Recent healthy connector does not claim current external connectivity',t=>{
  const a=setup(t);a.data.connectors=[{id:'c',projectId:'p',name:'需求文档',enabled:true,health:'healthy',lastSuccessAt:new Date().toISOString(),cursor:{token:'PRIVATE_CURSOR'}}];const r=health.snapshot(a);assert.ok(codes(r).includes('connector_paging'));assert.ok(!codes(r).includes('connector_stale'));assert.ok(!JSON.stringify(r).includes('PRIVATE_CURSOR'));assert.ok(codes(r).includes('network_unverified'));
});
test('Recovering workspace and backup failures remain visible without resuming anything',t=>{
  const a=setup(t);a.data.runtime={stewardshipRecoveryHold:true,recoveryNotice:'PRIVATE_NOTICE',backupError:'PRIVATE_ERROR'};const before=JSON.stringify(a.data);const r=health.snapshot(a);assert.ok(codes(r).includes('recovery_hold'));assert.ok(codes(r).includes('backup_error'));assert.equal(JSON.stringify(a.data),before);assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
});
test('Malformed legacy optional collections and nested records do not crash or become passing checks',t=>{
  const a=setup(t);a.data.folders=[null,{id:'broken',path:77,stats:'wrong'}];a.data.delegations=[{id:'legacy',taskIds:null,folderIds:{},projectId:'p',maxCalls:'x'}];a.data.connectors='wrong';a.data.workRules=null;a.data.modelCalls=[null,{at:'bad',status:'error'}];a.data.stewardship={timeZone:'bad'};a.data.settings=null;
  const r=health.snapshot(a);for(const code of ['legacy_folders','legacy_connectors','legacy_workRules','meter_unknown'])assert.ok(codes(r).includes(code));assert.equal(r.modelCalls,0);
});
test('Known secrets, full paths, URLs, query parameters and raw errors are absent from snapshot and export',t=>{
  const a=setup(t);a.data.providers=[{id:'p1',sealedKey:'PRIVATE_KEY',apiKey:'PRIVATE_API',baseUrl:'https://private.example/v1?token=PRIVATE_QUERY'}];a.data.agentSettings={githubToken:'PRIVATE_GITHUB',searchKey:'PRIVATE_SEARCH',outputFolder:'/Users/example/private-output'};job(a,{title:'PRIVATE_KEY PRIVATE_API PRIVATE_GITHUB PRIVATE_SEARCH /Users/example/private-output https://x.test?token=PRIVATE_QUERY',status:'blocked',goal:'PRIVATE_GOAL'});task(a,{status:'blocked',description:'PRIVATE_BODY',lastError:'PRIVATE_ERROR'});
  for(const result of [JSON.stringify(health.snapshot(a)),health.exportReport(a,{format:'json'}).content,health.exportReport(a,{format:'md'}).content]){assert.ok(!result.includes('PRIVATE_'));assert.ok(!result.includes('/Users/example'));assert.ok(!result.includes('https://'));}
});
test('Exports omit names, IDs and routes while retaining useful diagnostics, timestamps and counts',t=>{
  const a=setup(t);job(a,{id:'UNIQUE_JOB_ID',title:'UNIQUE_PRIVATE_TITLE',status:'limited',maxCalls:10,callsUsed:10});const before=JSON.stringify(a.data),json=health.exportReport(a,{projectId:'p',format:'json'}),report=JSON.parse(json.content);assert.equal(json.mime,'application/json');assert.ok(!json.content.includes('UNIQUE_'));assert.ok(!json.content.includes('本项目'));assert.ok(!json.content.includes('route'));assert.ok(report.findings.some(f=>f.code==='job_limit'&&f.evidence.includes('已用调用：10')));assert.equal(JSON.stringify(a.data),before);assert.ok(health.exportReport(a,{format:'md'}).content.includes('## 检查发现'));assert.throws(()=>health.exportReport(a,{format:'html'}));
});
test('Recent model failures are scoped and older failures are omitted',t=>{
  const a=setup(t);job(a,{id:'pjob'});job(a,{id:'qjob',projectId:'q'});at('2026-10-02T01:00:00Z',()=>{a.data.modelCalls=[{jobId:'pjob',status:'error',at:'2026-10-02T00:00:00Z'},{jobId:'qjob',status:'error',at:'2026-10-02T00:00:00Z'},{jobId:null,status:'error',at:'2026-10-02T00:00:00Z'},{jobId:'pjob',status:'error',at:'2026-09-01T00:00:00Z'}];assert.ok(health.snapshot(a,{projectId:'p'}).findings.find(f=>f.code==='recent_model_failures').evidence.includes('失败调用：1 次'));assert.ok(health.snapshot(a,{projectId:'@independent'}).findings.find(f=>f.code==='recent_model_failures').evidence.includes('失败调用：1 次'));assert.ok(health.snapshot(a).findings.find(f=>f.code==='recent_model_failures').evidence.includes('失败调用：3 次'));});
});
test('Missing folder grants and changed rule revisions are identified without granting permissions',t=>{
  const a=setup(t);job(a,{folderIds:['gone'],ruleId:'rule',ruleRevision:1});a.data.workRules=[{id:'rule',status:'enabled',revision:2,config:{},usage:{}}];const before=JSON.stringify(a.data),r=health.snapshot(a);assert.ok(codes(r).includes('missing_folder_grant'));assert.ok(codes(r).includes('job_rule'));assert.equal(JSON.stringify(a.data),before);
});
test('Web subscription health is scoped and routes to exact subscription without URL or failure body',t=>{
  const a=setup(t);a.data.webConnections=[{id:'web-p',projectId:'p',name:'项目网页',enabled:true,health:'error',url:'https://private.example?key=PRIVATE_QUERY',error:'PRIVATE_FAILURE'},{id:'web-q',projectId:'q',name:'FOREIGN_WEB',enabled:true,health:'error'}];
  const r=health.snapshot(a,{projectId:'p'});assert.ok(codes(r).includes('web_failed'));assert.equal(r.findings.find(f=>f.code==='web_failed').route.webConnectionId,'web-p');assert.ok(!JSON.stringify(r).includes('PRIVATE_'));assert.ok(!JSON.stringify(r).includes('FOREIGN_WEB'));
});
test('Failed and queued captures retain clear import receipts and intentional waiting',t=>{
  const a=setup(t);a.data.captureQueue=[{id:'failed',projectId:'p',status:'failed',itemTitles:['需求文档'],sourceIds:['one'],importedAt:'2026-10-02T00:00:00Z',lastError:'PRIVATE_ERROR'},{id:'queued',projectId:'p',status:'queued',sourceIds:[],itemTitles:['待整理']},{id:'cancelled',projectId:'p',status:'cancelled',itemTitles:['不应显示']},{id:'other',projectId:'q',status:'failed',itemTitles:['FOREIGN_CAPTURE']}];
  const r=health.snapshot(a,{projectId:'p'});assert.equal(r.findings.find(f=>f.code==='capture_failed').route.queueId,'failed');assert.ok(r.findings.find(f=>f.code==='capture_failed').evidence.includes('已导入材料：1 份'));assert.equal(r.findings.find(f=>f.code==='capture_queued').severity,'info');assert.ok(!JSON.stringify(r).includes('不应显示'));assert.ok(!JSON.stringify(r).includes('FOREIGN'));assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
});
test('Rule daily quotas are visible before a job starts and yesterday totals do not block today',t=>{
  const a=setup(t),d=new Date(),day=`${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;a.data.workRules=[{id:'limited-rule',status:'enabled',config:{projectId:'p',name:'每日资料',dailyCalls:10,dailyStarts:2},usage:{day,calls:10,starts:2},pending:['new-change']}];
  const r=health.snapshot(a,{projectId:'p'});assert.ok(!codes(r).includes('rule_call_limit'));assert.ok(codes(r).includes('rule_start_limit'));assert.ok(!codes(health.snapshot(a,{projectId:'q'})).includes('rule_call_limit'));a.data.workRules[0].usage.day='2000-1-1';assert.ok(!codes(health.snapshot(a)).includes('rule_call_limit'));
});
test('Paused rules are intentional arrangements even if an old usage count reached quota',t=>{
  const a=setup(t);a.data.workRules=[{id:'paused-rule',status:'paused',config:{projectId:'p',name:'暂停规则',dailyCalls:5},usage:{day:'2000-1-1',calls:20}}];const r=health.snapshot(a);assert.equal(r.findings.find(f=>f.code==='rule_paused').severity,'info');assert.ok(!codes(r).includes('rule_call_limit'));
});
