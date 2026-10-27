'use strict';
// Actual packaged renderer -> IPC -> worker -> HTTP adapter. The only model
// endpoint is a loopback fixture; its usage values are synthetic, not live data.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function verify({executable,out}){
 const {_electron:electron,expect}=require('playwright/test');
 fs.mkdirSync(out,{recursive:true});
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'行知 foundation '))),profile=path.join(directory,'profile');
 const sourceText='会议确认：产品定于周五发布，仅限内测用户。',draftText='产品定于周五发布，仅限内测用户。';
 const requests=[],checks=[],errors=[];let app,sourceId,reads=0,mode='valid',failure,result;
 const server=http.createServer(async(req,res)=>{
  try{
   assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const request=JSON.parse(Buffer.concat(chunks).toString()),payload=JSON.parse(request.messages[1].content);
   assert.ok(requests.length<6,'Unexpected fixture request');assert.notEqual(request.stream,true);
   const stage=payload.groundingReviewRequest?'verify':'execute';requests.push({stage,mode});let answer;
   if(stage==='execute')answer={kind:'artifact',title:'发布摘要',content:draftText,summary:'离线测试文稿'};
   else if(mode==='invalid')answer={passed:true,summary:'缺少证据清单的错误肯定结论',gaps:[]};
   else if(reads++===0)answer={kind:'read_context',requests:[{tool:'read_source',sourceId}]};
   else answer={passed:true,summary:'已按原文核对',gaps:[],groundingReview:{format:'compact-v3',
    scannedArtifactIds:payload.groundingReviewRequest.artifactIds,
    citations:[{id:'e1',sourceId,quote:sourceText}],
    requirements:payload.groundingChecklist.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:['c1']})),
    claims:[{id:'c1',artifactId:payload.groundingReviewRequest.artifactIds[0],text:draftText,kind:'fact',supported:true,citationIds:['e1']}],
    unsupportedClaims:[],conflicts:[]}};
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(answer)}}],usage:{prompt_tokens:100,completion_tokens:20}}));
  }catch(error){errors.push(error.message);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Offline fixture rejected unexpected request'}}));}
 });
 const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ASSISTANT_TEST_DATA_DIR','ASSISTANT_DESKTOP_FIXTURE','ASSISTANT_ENGINE_FIXTURE'])delete env[key];
 const launch=()=>electron.launch({executablePath:executable,args:['--user-data-dir='+profile],env,timeout:45000});
 let page;
 const attachPage=async()=>{page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.assistant);};
 const api=(action,input={})=>page.evaluate(async({action,input})=>{const r=await window.assistant.call(action,input);if(r.error)throw Error(r.error);return r.data;},{action,input});
 const settle=async id=>{await expect.poll(async()=>{const state=await api('state');return state.tasks.find(t=>t.id===id)?.status;},{timeout:45000}).toMatch(/^(review|blocked)$/);return (await api('state')).tasks.find(t=>t.id===id);};
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));app=await launch();await attachPage();
  const identity=await app.evaluate(({app})=>({packaged:app.isPackaged,profile:app.getPath('userData'),version:app.getVersion(),appPath:app.getAppPath()}));
  assert.equal(identity.packaged,true);assert.equal(identity.profile,profile);
  const before=await api('state');assert.equal(before.providers.length,0);assert.equal(before.tasks.length,0);
  await api('settings',{automatic:false,autoComplete:false,evidenceGrounding:true});
  await api('saveProvider',{name:'离线交付验证替身',type:'openai',model:'offline-fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,key:'SYNTHETIC_LOCAL_ONLY',inputPrice:0,outputPrice:0});
  await api('captureSave',{organize:false,textItems:[{title:'发布会议',content:sourceText}]});sourceId=(await api('state')).sources[0].id;
  const create=async title=>{await api('createTask',{title,description:'根据会议记录撰写发布摘要。',criteria:'说明发布日期和适用用户。',sourceIds:[sourceId],generationMode:'single',steps:[{title:'撰写摘要',kind:'draft'}]});return (await api('state')).tasks.find(t=>t.title===title).id;};
  const validId=await create('基础版离线发布摘要');await api('advance',{id:validId});const review=await settle(validId);
  assert.equal(review.status,'review',review.lastError);assert.equal(review.grounding.passed,true);assert.equal(requests.length,3);
  const citation=review.grounding.claims[0].citations[0];assert.equal(citation.quote,sourceText);assert.equal(citation.start,0);assert.equal(citation.end,sourceText.length);assert.ok(citation.version);
  checks.push('实际包经 renderer/IPC/worker/HTTP 完成一轮生成、读取原文及独立核验，3 次 loopback 替身调用');
  await app.close();app=null;app=await launch();await attachPage();
  assert.equal((await api('state')).tasks.find(t=>t.id===validId).status,'review');
  await api('taskAction',{id:validId,command:'accept'});assert.equal((await api('state')).tasks.find(t=>t.id===validId).status,'completed');
  checks.push('核验通过后冷启动仍待人工验收；通过实际 IPC 人工接受后才变为 completed');
  mode='invalid';const invalidId=await create('基础版离线缺证拦截');await api('advance',{id:invalidId});const blocked=await settle(invalidId);
  assert.equal(blocked.status,'blocked');assert.equal(blocked.grounding.passed,false);
  await assert.rejects(api('taskAction',{id:invalidId,command:'accept'}),/检查|核验|验收/);
  assert.equal(requests.length,5);checks.push('缺少证据清单的肯定结论被阻断，人工接受也不能绕过证据门槛');
  await app.close();app=null;app=await launch();await attachPage();
  const final=await api('state'),status=await api('groundingStatus');
  assert.equal(final.tasks.find(t=>t.id===validId).status,'completed');assert.equal(final.tasks.find(t=>t.id===invalidId).status,'blocked');
  assert.equal(final.settings.evidenceGrounding,true);assert.equal(final.settings.automatic,false);assert.equal(final.settings.autoComplete,false);
  assert.equal(requests.length,5);assert.deepEqual(errors,[]);
  checks.push('再次完全退出并冷启动保留人工验收结果、拦截结果与严格核验/手动控制设置，无新增替身调用');
  result={passed:true,checkedAt:new Date().toISOString(),version:identity.version,packaged:true,isolatedWorkspace:path.join(profile,'workspace'),asarSha256:sha(fs.readFileSync(identity.appPath)),grounding:status,checks,loopbackRequests:requests,syntheticUsage:true,liveModelCalls:0,actualUserWorkspaceTouched:false,rendererErrors:errors};
 }catch(error){failure=error;result={passed:false,isolatedWorkspace:path.join(profile,'workspace'),checks,error:error.stack,loopbackRequests:requests,liveModelCalls:0,actualUserWorkspaceTouched:false,rendererErrors:errors};}
 try{await app?.close();}catch(error){failure ||= error;result.passed=false;result.shutdownError=error.message;}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 fs.writeFileSync(path.join(out,'foundation-smoke.json'),JSON.stringify(result,null,2));
 // Keep the isolated fixture workspace for audit; it contains synthetic data only.
 if(failure)throw failure;return result;
}
module.exports={verify};
if(require.main===module)verify({executable:path.resolve(process.argv[2]),out:path.resolve(process.argv[3])}).then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(error);process.exitCode=1;});
