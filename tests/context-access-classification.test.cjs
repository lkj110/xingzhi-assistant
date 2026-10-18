const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const access=require('../desktop/access.cjs'),errors=require('../desktop/model-errors.cjs');
const documentURL='https://test.feishu.cn/docx/ContextAccessFixture';
const externalTools=['read_url','search_web','read_lark_document','lark_create','lark_update','github_list','github_read','github_create','github_update','github_comment','platform_inventory','read_platform','platform_query','capability_call'];
const localTools=[...new Set([...Object.keys(require('../desktop/tool-registry.cjs').registry).filter(tool=>!externalTools.includes(tool)),'verify_task','read_context','read_segment','read_section','model_request','unknown_tool','github_delete','read_url_extra'])];
const argsFor=tool=>({url:tool==='read_lark_document'?documentURL:'https://example.invalid/private',query:'fixture',sourceId:'platform-source',capabilityId:'fixture-capability',tool:'lookup',input:{},number:12});
const authMessage='内部诊断提及权限、登录、HTTP 401 / 403、permission denied';
function fixture(){
 const job={id:'job',taskIds:[],sourceIds:[],urls:[],status:'ready',allowWeb:false,githubRepo:'fixture/repo',dataPlatform:'sg-readonly',larkCreateGrant:{target:'folder:FixtureFolder'},callsUsed:7,history:[],executionState:{permissionRevision:3}};
 const events=[],a={data:{delegations:[job],tasks:[],sources:[],decisions:[],agentActions:[]},saves:0,save(){this.saves++;},event(...args){events.push(args);}};
 return {a,job,events};
}
const internalDomains=[
 ...['CONTEXT_LINK_MISSING','CONTEXT_VERSION_CHANGED','CONTEXT_INVALID_REQUEST','CONTEXT_SCOPE_DENIED','CONTEXT_FUTURE_DOMAIN','MODEL_AUTH','MODEL_HTTP','MODEL_STORAGE','MODEL_FUTURE_DOMAIN','STORAGE_FAILURE','STORAGE_FUTURE_DOMAIN','ACCESS_POLICY_STORAGE_FAILURE','ACCESS_POLICY_INVALID_REQUEST','EXECUTION_GATE_CLOSED','EXECUTION_FUTURE_DOMAIN','POLICY_TASK_MISMATCH','BUDGET_EXCEEDED','SPEND_LIMIT','STEWARDSHIP_BUDGET','WORK_JOURNAL_CONFLICT','ENGINE_CLOSING','EXTERNAL_EFFECT_UNCERTAIN','EACCES','EPERM','EROFS','ENOSPC','EDQUOT','EIO','OPERATION_STALE','STATE_STALE','EVALUATION_LIMIT'].map(code=>[code,{code}]),
 ...['contextFailure','modelFailure','localPersistence','gateClosed','spendLimit','stewardshipBudget','stewardshipMeter','noProgress','planInputInvalid','invalidDelivery','conflict'].map(flag=>[flag,{[flag]:true}]),
 ['cancelled',{name:'AbortError'}],['storage recovery',{recovery:'diagnose_storage'}],['internal diagnostic',{recovery:'system_diagnostic'}],
 ['unwritable policy store',{code:'ACCESS_POLICY_UNKNOWN',reason:'unwritable'}],['corrupt policy store',{code:'ACCESS_POLICY_UNKNOWN',reason:'corrupt_or_incomplete'}],
];
for(const [domain,fields] of internalDomains)test(`internal ${domain} wins across every local/external tool and mixed connector metadata`,()=>{
 for(const tool of [...localTools,...externalTools])for(const connectorCode of [undefined,'auth','permission','missing_cli']){
  const {a,job,events}=fixture(),before=structuredClone(a.data),error=Object.assign(Error(authMessage),fields,{connectorCode,httpStatus:401}),label=`${domain} × ${tool} × ${connectorCode||'legacy'}`;
  assert.equal(access.recoveryCandidate(tool,error),false,label);
  assert.equal(access.recover(a,job,tool,argsFor(tool),error),null,label);
  assert.deepEqual(a.data,before,label);assert.equal(a.saves,0,label);assert.deepEqual(events,[],label);
 }
});
test('local, file and unknown tools never manufacture generic external permission decisions',()=>{
 const failures=[Error(authMessage),...['auth','permission','missing_cli'].map(connectorCode=>Object.assign(Error('opaque connector response'),{connectorCode})),...['AUTH_REQUIRED','ACCESS_POLICY_UNKNOWN','ACCESS_POLICY_REVOKED','ACCESS_PRINCIPAL_UNKNOWN','ACCESS_PRINCIPAL_CHANGED'].map(code=>Object.assign(Error('opaque policy response'),{code}))];
 for(const tool of localTools)for(const error of failures){
  const {a,job}=fixture(),before=structuredClone(a.data);
  assert.equal(access.recoveryCandidate(tool,error),false,tool);assert.equal(access.recover(a,job,tool,argsFor(tool),error),null,tool);assert.deepEqual(a.data,before,tool);assert.equal(a.saves,0);
 }
});
test('explicit external allowlist retains real connector, policy and legacy permission entry points',()=>{
 const failures=[...['权限不足','请重新登录','HTTP 401','HTTP 403','permission denied','unauthorized','forbidden','missing_scope'].map(message=>Error(message)),...['auth','permission','missing_cli'].map(connectorCode=>Object.assign(Error('opaque connector response'),{connectorCode})),...['AUTH_REQUIRED','ACCESS_POLICY_UNKNOWN','ACCESS_POLICY_REVOKED','ACCESS_PRINCIPAL_UNKNOWN','ACCESS_PRINCIPAL_CHANGED',401,403].map(code=>Object.assign(Error('opaque external response'),{code})),Object.assign(Error('opaque HTTP response'),{httpStatus:401})];
 for(const tool of externalTools)for(const error of failures){
  const {a,job}=fixture(),before={callsUsed:job.callsUsed,permissionRevision:job.executionState.permissionRevision};
  assert.equal(access.recoveryCandidate(tool,error),true,`${tool}: ${error.message}`);
  const result=access.recover(a,job,tool,argsFor(tool),error),decision=a.data.decisions[0];
  assert.equal(result.needsAuthorization,true,tool);assert.equal(decision.kind,'permission');assert.equal(decision.status,'open');assert.equal(job.status,'needs_input');
  assert.equal(job.callsUsed,before.callsUsed);assert.equal(job.executionState.permissionRevision,before.permissionRevision);assert.equal(job.allowWeb,false);
  assert.equal(access.recover(a,job,tool,argsFor(tool),error).decisionId,result.decisionId);assert.equal(a.data.decisions.length,1);
 }
});
test('external non-auth failures and unknown typed domains do not fall back to message matching',()=>{
 for(const tool of externalTools)for(const error of [Error('transport unavailable'),Object.assign(Error(authMessage),{code:'INVALID_PLATFORM_RESPONSE'}),Object.assign(Error(authMessage),{code:'INVALID_ARGUMENT'}),Object.assign(Error(authMessage),{code:'UNKNOWN_INTERNAL_DOMAIN',connectorCode:'auth'}),Object.assign(Error(authMessage),{connectorCode:'connection'}),Object.assign(Error(authMessage),{connectorCode:'cursor'}),Object.assign(Error(authMessage),{connectorCode:'unknown'})]){
  const {a,job}=fixture();assert.equal(access.recoveryCandidate(tool,error),false,tool);assert.equal(access.recover(a,job,tool,argsFor(tool),error),null,tool);assert.equal(a.data.decisions.length,0);assert.equal(a.saves,0);
 }
 assert.equal(access.recoveryCandidate('read_url',null),false);assert.equal(access.recoveryCandidate('read_url',undefined),false);
});
test('real authorization requests retain the original resource and Lark permission stage',()=>{
 for(const tool of ['read_lark_document','read_url'])for(const permissionKind of ['scope','resource']){
  const {a,job}=fixture(),result=access.recover(a,job,tool,{url:documentURL},Object.assign(Error('denied'),{connectorCode:'permission',permissionKind}));
  assert.equal(result.kind,'lark_document');assert.equal(result.target,documentURL);assert.equal(a.data.decisions[0].access.stage,permissionKind);assert.equal(job.documentGrants,undefined);
 }
 for(const tool of ['lark_create','lark_update']){
  const {a,job}=fixture(),result=access.recover(a,job,tool,{},Object.assign(Error('expired'),{connectorCode:'auth'}));
  assert.equal(result.kind,'lark_create');assert.equal(result.target,'folder:FixtureFolder');assert.equal(a.data.decisions[0].access.stage,'login');
 }
 for(const [tool,resource] of [['read_url','https://example.invalid/private'],['github_read','fixture/repo'],['platform_query','sg-readonly'],['platform_inventory','sg-readonly'],['read_platform','platform-source'],['capability_call','fixture-capability']]){
  const {a,job}=fixture();job.allowWeb=true;
  const result=access.recover(a,job,tool,argsFor(tool),Error('HTTP 403'));
  assert.equal(result.kind,'external');assert.equal(result.target,`${tool} · ${resource}`);
 }
});
test('rejected real context/storage/effect errors preserve original diagnostics and retry facts',()=>{
 for(const error of [errors.contextError('CONTEXT_INVALID_REQUEST',{message:authMessage,noProgress:true,recovery:'system_diagnostic'}),errors.contextError('CONTEXT_SCOPE_DENIED',{message:authMessage}),errors.storageError(),errors.httpError(401),Object.assign(Error(authMessage),{code:'EXTERNAL_EFFECT_UNCERTAIN',requiresInput:true,actionId:'original-action'})]){
  const {a,job}=fixture(),before={...error,message:error.message};
  assert.equal(access.recover(a,job,'lark_update',{},error),null);assert.deepEqual({...error,message:error.message},before);assert.deepEqual(a.data.decisions,[]);
 }
});
async function agentFixture(t){
 const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-access-classification-'));
 const denied=async()=>{throw Error('Unexpected network/connector/model request in R1 fixture');};
 const a=new Assistant({dir,chat:denied,agentRequest:denied,connectorRequest:denied,platformRequest:denied});
 t.after(()=>{access.cancel(a);fs.rmSync(dir,{recursive:true,force:true});});
 await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
 const job=agent.buildJob(a,{goal:'核对原稿',allowWeb:false,fileMode:'off',githubMode:'off'});job.maxActions=1;a.data.delegations.push(job);
 const {taskId}=await agent.act(a,job,'plan_task',{key:'draft',title:'原稿检查',criteria:'核对事实',steps:[{key:'draft',kind:'draft',title:'原稿'}]});
 return {a,job,taskId,agent};
}
test('agent catch uses the shared predicate and never enters access recovery for an internal verify failure',async t=>{
 const {a,job,taskId,agent}=await agentFixture(t),control=require('../desktop/execution-control.cjs');
 const error=errors.contextError('CONTEXT_INVALID_REQUEST',{message:authMessage,noProgress:true,recovery:'system_diagnostic'});
 a.chat=async()=>({tool:'verify_content',args:{taskId}});
 const verify=t.mock.method(control,'verifyContent',async()=>{throw error;}),candidate=t.mock.method(access,'recoveryCandidate'),recover=t.mock.method(access,'recover');
 await agent.run(a,job.id);
 assert.equal(verify.mock.callCount(),1);assert.equal(recover.mock.callCount(),0);
 assert.ok(candidate.mock.calls.some(call=>call.arguments[0]==='verify_content'&&call.arguments[1]===error&&call.result===false));
 const step=a.data.agentRuns[0].steps.find(step=>step.tool==='verify_content');
 assert.equal(step.errorCode,'CONTEXT_INVALID_REQUEST');assert.equal(step.error,authMessage);assert.equal(step.result?.needsAuthorization,undefined);
 assert.equal(a.data.decisions.some(d=>d.kind==='permission'),false);
});
test('agent catch still requests web authorization for a real ungranted external read',async t=>{
 const {a,job,agent}=await agentFixture(t);a.chat=async()=>({tool:'read_url',args:{url:'https://example.invalid/private'}});
 const candidate=t.mock.method(access,'recoveryCandidate'),recover=t.mock.method(access,'recover');
 await agent.run(a,job.id);
 assert.equal(recover.mock.callCount(),1);assert.ok(candidate.mock.calls.every(call=>call.result===true));
 assert.equal(job.status,'needs_input');assert.equal(a.data.decisions[0].access.kind,'web');assert.equal(job.allowWeb,false);
});
