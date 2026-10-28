'use strict';
// Offline-only packaged-app regression. Real renderer/IPC/worker and HTTP
// adapter; the sole provider is a nonce-protected loopback synthetic fixture.
// Automated clicks exercise human-command routes, not actual human acceptance.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const root=path.resolve(__dirname,'..');
async function verify({executable,manifest,output}){
 assert.equal(process.platform,'win32');
 for(const p of [executable,manifest,output])assert.ok(path.isAbsolute(p));
 assert.ok(!fs.existsSync(output),'Use a new evidence directory');
 const bundle=path.dirname(fs.realpathSync.native(executable)),identity=JSON.parse(fs.readFileSync(manifest,'utf8'));
 assert.match(path.basename(bundle),/^foundation-candidate-bundle-marker-/);
 const {inventory}=require('./prepare-foundation-candidate.cjs');
 assert.deepEqual(inventory(bundle),identity.files,'Candidate identity changed');
 const data=require('../evaluations/foundation-coverage/validate.cjs');
 const coverage=data.load();data.checkReview(data.validate(coverage),require('../evaluations/foundation-requirements-regression-20261028/coverage-review.json'));
 const pack=path.join(root,'evaluations/foundation-notice-acceptance-20261028');
 const spec=JSON.parse(fs.readFileSync(path.join(pack,'stimuli.json'),'utf8')).cases.find(c=>c.id==='P01-qingjia-notice');
 const gold=JSON.parse(fs.readFileSync(path.join(pack,'gold.json'),'utf8')).cases.find(c=>c.id===spec.id);
 const reference=coverage.references.find(c=>c.caseId===spec.id),input=require(path.join(pack,'inputs.cjs')).project(spec);
 fs.mkdirSync(output,{recursive:true});
 const temp=fs.realpathSync.native(os.tmpdir()),directory=fs.mkdtempSync(path.join(temp,'xingzhi-marker-package-')),profile=path.join(directory,'profile');
 const {_electron:electron,expect}=require('playwright/test'),nonce=crypto.randomBytes(16).toString('hex');
 const requests=[],errors=[],checkpoints=[],cases=new Map(),boots=[];let app,page,sourceIds,result,failure,attempts=0;
 const server=http.createServer(async(req,res)=>{
  try{
   attempts++;assert.ok(attempts<=24,'Offline request ceiling exceeded');assert.equal(errors.length,0,'Fixture already failed; do not retry');
   assert.equal(req.method,'POST');assert.equal(req.url,'/'+nonce+'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer SYNTHETIC_LOCAL_ONLY_'+nonce);
   const parts=[];for await(const part of req)parts.push(part);
   const request=JSON.parse(Buffer.concat(parts).toString()),payload=JSON.parse(request.messages[1].content),testCase=cases.get(payload.task?.id);
   assert.ok(testCase,'Unexpected fixture task');assert.ok(requests.length<24,'Offline request ceiling exceeded');assert.notEqual(request.stream,true);
   const stage=payload.groundingReviewRequest?'verify':'execute';let answer,kind;
   if(stage==='execute'){
    assert.equal(testCase.generated,false,'Recheck must not generate or replace a draft');testCase.generated=true;kind='draft';
    answer={kind:'artifact',title:reference.title,content:reference.content,summary:'OFFLINE synthetic reference draft'};
   }else if(testCase.readRequired){
    testCase.readRequired=false;kind='read_context';answer={kind:'read_context',requests:sourceIds.map(sourceId=>({tool:'read_source',sourceId}))};
   }else{
    kind='verdict';const ids=payload.groundingReviewRequest.artifactIds;assert.equal(ids.length,1);
    const citations=input.sources.map((s,i)=>({id:'e'+i,sourceId:sourceIds[i],quote:s.content,start:0})),citationIds=citations.map(c=>c.id);
    const claims=[{id:'c1',artifactId:ids[0],text:reference.content,kind:'fact',supported:true,citationIds},...gold.notificationClaims.map((c,i)=>({id:'n'+i,artifactId:ids[0],...c,supported:true,citationIds}))];
    answer={passed:true,summary:'OFFLINE synthetic independent verdict',gaps:[],groundingReview:{format:'compact-v3',scannedArtifactIds:ids,citations,requirements:payload.groundingChecklist.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:claims.map(c=>c.id)})),claims,unsupportedClaims:[],conflicts:[]}};
    if(testCase.mode==='invalid_quote')citations[0].quote+='不存在的附加文字';
    if(testCase.mode==='independent_refusal'){
     answer.passed=false;answer.gaps=['离线故障注入：独立核验不支持该结论'];claims.find(c=>c.id==='n1').supported=false;
     answer.groundingReview.unsupportedClaims=['n1'];answer.groundingReview.conflicts=['离线故障注入：存在未解决冲突'];
    }
   }
   const record={index:requests.length+1,caseId:testCase.id,taskId:payload.task.id,stage,kind,mode:testCase.mode,requestSha256:sha(JSON.stringify(request)),answerSha256:sha(JSON.stringify(answer)),syntheticUsage:{input:100,output:20}};requests.push(record);
   fs.writeFileSync(path.join(output,`exchange-${String(record.index).padStart(2,'0')}.json`),JSON.stringify({record,request,answer},null,2)+'\n',{flag:'wx'});
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(answer)}}],usage:{prompt_tokens:100,completion_tokens:20}}));
  }catch(error){errors.push(error.stack);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Offline fixture rejected unexpected request'}}));}
 });
 const env={...process.env};
 for(const key of Object.keys(env))if(['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ASSISTANT_TEST_DATA_DIR','ASSISTANT_DESKTOP_FIXTURE','ASSISTANT_ENGINE_FIXTURE'].includes(key)||/^(OPENAI|ANTHROPIC|AZURE_OPENAI)_/.test(key))delete env[key];
 const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
 const ui=(action,input={})=>api('uiCommand',{action,input});
 const state=()=>api('state');
 const task=async id=>(await state()).tasks.find(t=>t.id===id);
 async function launch(){
  assert.deepEqual(inventory(bundle),identity.files);
  app=await electron.launch({executablePath:executable,args:['--user-data-dir='+profile],env,timeout:45000});
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.stack));await page.waitForFunction(()=>!!window.assistant);
  const actual=await app.evaluate(({app})=>({packaged:app.isPackaged,profile:app.getPath('userData'),appPath:app.getAppPath(),version:app.getVersion()}));
  assert.equal(actual.packaged,true);assert.equal(actual.version,identity.version);assert.equal(sha(fs.readFileSync(actual.appPath)),identity.asarSha256);assert.equal(fs.realpathSync.native(actual.profile),fs.realpathSync.native(profile));assert.equal(fs.realpathSync.native(actual.appPath),fs.realpathSync.native(path.join(bundle,'resources/app.asar')));
  const grounding=await api('groundingStatus');assert.equal(grounding.implementationHash,identity.groundingSha256);
  boots.push({index:boots.length+1,packaged:actual.packaged,version:actual.version,asarSha256:sha(fs.readFileSync(actual.appPath)),groundingImplementationHash:grounding.implementationHash,requestsAtBoot:requests.length});
 }
 async function restart(label){const count=requests.length;await app.close();app=null;await launch();assert.equal(requests.length,count,'Restart invoked the model');checkpoints.push({name:label,requests:count});}
 async function settle(id,status){
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){
   assert.deepEqual(errors,[],'Fixture or renderer failure stops this run');const s=await state(),t=s.tasks.find(t=>t.id===id);
   if(!s.operation&&['waiting','review','blocked','completed'].includes(t.status)){assert.equal(t.status,status,t.lastError||t.verification?.summary);return t;}
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw Error('Packaged lifecycle did not settle before its deadline');
 }
 async function openTask(id){await page.reload();await page.waitForFunction(()=>!!window.assistant);const t=await task(id);await page.locator('.task-card').filter({hasText:t.title}).click();await expect(page.getByRole('region',{name:'表达标记人工确认'})).toBeVisible();}
 function assertWait(t){assert.equal(t.status,'waiting');assert.equal(t.grounding.passed,false);assert.equal(t.verification.passed,false);assert.ok(t.markerReviewHold);assert.equal(t.acceptedAt,undefined);assert.equal(t.verificationCheckpoint,undefined);}
 async function assertDraft(id){const s=await state(),t=s.tasks.find(t=>t.id===id),artifact=s.artifacts.find(a=>a.id===t.steps[0].artifactId);assert.equal(artifact.title,reference.title);assert.equal(artifact.content,reference.content);for(const c of t.grounding.claims)for(const q of c.citations){const source=s.sources.find(x=>x.id===q.sourceId);assert.equal(source.content.slice(q.start,q.end),q.quote);}return sha(JSON.stringify([artifact.title,artifact.content]));}
 async function create(id,mode='valid'){
  const title='离线候选 '+id;await ui('createTask',{...input,title,sourceIds,generationMode:'single',steps:[{title:'形成通知',kind:'draft'}]});
  const t=(await state()).tasks.find(t=>t.title===title);cases.set(t.id,{id,generated:false,readRequired:true,mode});await ui('advance',{id:t.id});return t.id;
 }
 async function confirmClick(id){const before=requests.length;await openTask(id);if(cases.get(id).id==='M01')await page.getByRole('region',{name:'表达标记人工确认'}).screenshot({path:path.join(output,'marker-confirmation-region.png')});await page.getByRole('button',{name:'确认这些表达已清楚',exact:true}).click();await expect.poll(async()=>!!(await task(id)).groundingMarkerConfirmation).toBe(true);assert.equal(requests.length,before);const t=await task(id);assertWait(t);return t;}
 async function recheckClick(id,expected){cases.get(id).readRequired=true;await openTask(id);await page.getByRole('button',{name:'重新核验',exact:true}).click();return settle(id,expected);}
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await launch();const initial=await state();assert.equal(initial.tasks.length,0);assert.equal(initial.providers.length,0);
  await ui('guideDismiss');await ui('settings',{automatic:false,autoExtract:false,autoComplete:true,evidenceGrounding:true});
  await ui('saveProvider',{name:'仅本地离线模型替身',type:'openai',model:'offline-fixture',baseUrl:`http://127.0.0.1:${server.address().port}/${nonce}/v1`,key:'SYNTHETIC_LOCAL_ONLY_'+nonce,inputPrice:0,outputPrice:0});
  for(const source of input.sources)await ui('captureSave',{organize:false,textItems:[source]});
  const saved=await state();sourceIds=input.sources.map(s=>saved.sources.find(x=>x.title===s.title&&x.content===s.content).id);
  const positive=await create('M01');let t=await settle(positive,'waiting');assertWait(t);const original=await assertDraft(positive),reportHash=t.grounding.reportHash;
  assert.equal(requests.length,3);checkpoints.push({name:'initial-marker-waiting',taskId:positive,requests:requests.length,draftSha256:original,passed:false});
  await restart('waiting-cold-restart');t=await task(positive);assertWait(t);assert.equal(t.grounding.reportHash,reportHash);
  await assert.rejects(ui('advance',{id:positive}),/确认/);await assert.rejects(ui('taskAction',{id:positive,command:'accept'}),/核验|验收|检查/);
  t=await confirmClick(positive);const confirmation=t.groundingMarkerConfirmation.recordHash;await page.screenshot({path:path.join(output,'confirmed-waiting.png'),fullPage:true});
  await restart('confirmed-cold-restart');t=await task(positive);assertWait(t);assert.equal(t.groundingMarkerConfirmation.recordHash,confirmation);assert.equal(await assertDraft(positive),original);
  await assert.rejects(ui('advance',{id:positive}),/确认/);await assert.rejects(ui('taskAction',{id:positive,command:'accept'}),/核验|验收|检查/);
  t=await recheckClick(positive,'review');assert.equal(t.verification.passed,true);assert.equal(t.grounding.passed,true);assert.equal(t.grounding.humanMarkerConfirmation,confirmation);assert.equal(t.acceptedAt,undefined);assert.equal((await state()).settings.autoComplete,true);assert.equal(await assertDraft(positive),original);assert.equal(requests.length,5);
  await page.reload();await page.locator('.task-card').filter({hasText:t.title}).click();await page.getByRole('button',{name:'验收完成',exact:true}).click();t=await settle(positive,'completed');assert.equal(t.acceptedBy,'user');
  checkpoints.push({name:'automated-ui-accept-route',taskId:positive,requests:requests.length,simulatedHumanAction:true,actualHumanAcceptance:false});
  await restart('completed-cold-restart');assert.equal((await task(positive)).status,'completed');assert.equal(await assertDraft(positive),original);
  const refusal=await create('M02');assertWait(await settle(refusal,'waiting'));await confirmClick(refusal);cases.get(refusal).mode='independent_refusal';t=await recheckClick(refusal,'blocked');assert.equal(t.verification.passed,false);assert.equal(t.markerReviewHold,undefined);await assert.rejects(ui('taskAction',{id:refusal,command:'accept'}),/核验|验收|检查/);await assertDraft(refusal);
  checkpoints.push({name:'confirmed-expression-cannot-clear-independent-refusal',taskId:refusal,requests:requests.length});
  const invalid=await create('M03','invalid_quote');t=await settle(invalid,'blocked');assert.equal(t.grounding.passed,false);assert.equal(t.markerReviewHold,undefined);assert.match(t.grounding.issues.join('\n'),/引用与原文不匹配/);await assert.rejects(ui('confirmGroundingMarkers',{id:invalid,expectedReportHash:t.grounding.reportHash}),/变化|缺口/);await assert.rejects(ui('taskAction',{id:invalid,command:'accept'}),/核验|验收|检查/);
  checkpoints.push({name:'invalid-quote-cannot-enter-human-confirmation',taskId:invalid,requests:requests.length});
  const changed=await create('M04');assertWait(await settle(changed,'waiting'));t=await confirmClick(changed);const oldConfirmation=t.groundingMarkerConfirmation.recordHash,oldReport=t.grounding.reportHash;
  await ui('updateTask',{id:changed,criteria:input.criteria+'\n保留清洁尚未执行的时点说明。'});await assert.rejects(ui('confirmGroundingMarkers',{id:changed,expectedReportHash:oldReport}),/变化/);
  cases.get(changed).readRequired=true;await ui('advance',{id:changed});t=await settle(changed,'waiting');assertWait(t);assert.equal(t.grounding.humanMarkerConfirmation,undefined);assert.notEqual(t.grounding.basis,t.groundingMarkerConfirmation.basis);assert.equal(t.groundingMarkerConfirmation.recordHash,oldConfirmation);await assertDraft(changed);
  checkpoints.push({name:'changed-requirements-do-not-reuse-confirmation',taskId:changed,requests:requests.length});
  await restart('mixed-terminal-states-cold-restart');const final=await state();assert.equal(final.tasks.find(t=>t.id===positive).status,'completed');assert.equal(final.tasks.find(t=>t.id===refusal).status,'blocked');assert.equal(final.tasks.find(t=>t.id===invalid).status,'blocked');assertWait(final.tasks.find(t=>t.id===changed));
  assert.equal(requests.length,18);assert.equal(attempts,18);assert.equal(requests.filter(r=>r.stage==='execute').length,4);assert.deepEqual(errors,[]);assert.equal(final.providers.length,1);
  fs.writeFileSync(path.join(output,'final-state.json'),JSON.stringify(final,null,2)+'\n');
  result={schema:1,passed:true,scope:'offline-packaged-marker-lifecycle',sourceCommit:identity.sourceCommit,asarSha256:identity.asarSha256,groundingSha256:identity.groundingSha256,packaged:true,boots,checkpoints,requests,attempts,syntheticUsageOnly:true,realModelCalls:0,actualHumanAcceptance:false,simulatedHumanCommandRoute:true,officialCliProbePerformed:false,installed:false,userWorkspaceTouched:false,isolatedWorkspace:path.join(profile,'workspace'),errors};
 }catch(error){failure=error;result={schema:1,passed:false,error:error.stack,boots,checkpoints,requests,attempts,realModelCalls:0,actualHumanAcceptance:false,isolatedWorkspace:path.join(profile,'workspace'),errors};if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
 finally{
  try{await app?.close();}catch(error){failure ||= error;if(result){result.passed=false;result.shutdownError=error.message;}}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  try{assert.deepEqual(inventory(bundle),identity.files);}catch(error){failure ||= error;result.passed=false;result.packageIdentityError=error.message;}
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 }
 if(failure)throw failure;return result;
}
module.exports={verify};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},manifest:{type:'string'},output:{type:'string'}}});verify(values).then(r=>console.log(JSON.stringify({passed:r.passed,boots:r.boots.length,syntheticRequests:r.requests.length,realModelCalls:0,actualHumanAcceptance:false}))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
