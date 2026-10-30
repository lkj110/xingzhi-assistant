'use strict';
// A local UI/commit/restart diagnostic, never a human or real-model acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs'),acceptance=require('../desktop/acceptance.cjs'),journal=require('../desktop/work-journal.cjs');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const taskState=(a,id)=>{const task=a.data.tasks.find(row=>row.id===id);return {id:task.id,status:task.status,acceptedAt:task.acceptedAt||null,acceptedBy:task.acceptedBy||null,acceptanceHistory:(task.acceptanceHistory||[]).map(row=>({eventId:row.eventId,acceptedAt:row.acceptedAt,acceptedBy:row.acceptedBy})),acceptedEvents:journal.read(a).events.filter(row=>row.entityId===id&&row.type==='accepted').map(row=>({eventId:row.eventId,commitId:row.commitId,at:row.at}))};};
function dispose(a){if(a){require('../desktop/deadline-scheduler.cjs').dispose(a);require('../desktop/access.cjs').cancel(a);}}
function validateOutput(output,workspace){
 if(!path.isAbsolute(output))throw Error('Output path must be absolute');
 const target=path.join(fs.realpathSync(path.dirname(output)),path.basename(output));
 if(fs.existsSync(target))throw Error('Output must be a new file');
 if(workspace){const relative=path.relative(fs.realpathSync(workspace),target);if(!relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('Output must stay outside the source workspace');}
 return target;
}
async function run({workspace,taskId,mode='normal'}={}){
 assert.ok(['normal','before-commit-failure','projection-failure','refresh-failure'].includes(mode));
 const tempRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(tempRoot,'xingzhi-acceptance-offline-')),dir=path.join(directory,'workspace');
 const sourceHashes={},commands=[],errors=[],transports=[],externalBrowserRequests=[];let a,restarted,server,browser,acknowledged=false;
 const forbidden=async()=>{transports.push('blocked');throw Error('Offline acceptance forbids real model/network transport');};
 const make=()=>new Assistant({dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,officeRequest:forbidden,webRequest:forbidden,feedRequest:forbidden});
 try{
  fs.mkdirSync(dir);
  if(workspace){
   const origin=fs.realpathSync(workspace);assert.notEqual(origin,fs.realpathSync(dir));
   // Copy only flat state/authority files; never mutate the source or copy a vault.
   const allowed=['workspace.json','work-journal.json','access-policy.json','authorization-migration.json','action-facts.initialized','action-facts.json','action-ledger.json','spend-ledger.json','stewardship-ledger.json'];
   for(const name of allowed){const file=path.join(origin,name);if(fs.existsSync(file)){sourceHashes[name]=sha(file);fs.copyFileSync(file,path.join(dir,name));}}
   assert.ok(sourceHashes['workspace.json']&&sourceHashes['work-journal.json']);
  }
  a=make();
  if(!workspace){
   const task=a.createTask({title:'离线 F04 验收持久化回归',description:'比较两个来源，清楚保留差异。',criteria:'完整说明两份记录的不同',steps:[{title:'说明差异',kind:'draft'}]});
   taskId=task.id;task.status='review';task.steps[0].done=true;task.steps[0].artifactId='offline-result';
   a.data.artifacts.push({id:'offline-result',taskId,title:'离线差异说明',content:'两份记录不同，尚未确定实际方向。',createdAt:'2026-10-29T00:00:00Z'});
   task.verification={passed:true,summary:'保留差异，未擅自定论',gaps:[],at:'2026-10-29T00:00:00Z'};
  }
  const task=a.data.tasks.find(row=>row.id===taskId);assert.ok(task,'Requested task must exist');
  assert.equal(task.status,'review');assert.deepEqual(acceptance.reasons(a,task),[],'Actual task must pass unchanged acceptance preflight');
  // Only local presentation metadata is changed. Evidence and checks stay intact.
  a.data.runtime.onboarding={seenAt:new Date().toISOString(),version:2};a.save();
  const before=taskState(a,taskId),originalModelCalls=(a.data.modelCalls||[]).length;
  const otherStates=a.data.tasks.filter(row=>row.id!==taskId).map(row=>taskState(a,row.id));
  const {build,preview}=await import('vite'),{chromium}=require('playwright'),{expect}=require('playwright/test');
  const entry=path.join(__dirname,'../tests/foundation-acceptance-ui.fixture.jsx').replaceAll('\\','/');
  fs.writeFileSync(path.join(directory,'index.html'),`<div id="root"></div><script type="module" src="/@fs/${entry}"></script>`);
  await build({root:directory,configFile:false,logLevel:'error',build:{outDir:path.join(directory,'dist')}});
  server=await preview({root:directory,configFile:false,logLevel:'error',build:{outDir:path.join(directory,'dist')},preview:{host:'127.0.0.1',port:0}});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1200}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const host=new URL(route.request().url()).hostname;if(host==='127.0.0.1')return route.continue();externalBrowserRequests.push(host);return route.abort();});
  await page.exposeFunction('offlineAcceptanceCall',async(action,input={})=>{
   const allowed=action==='stateView'||action==='viewDetail'||action==='uiCommand'&&input.action==='taskAction'&&input.input?.command==='accept'&&input.input?.id===taskId;
   assert.ok(allowed,`Unexpected UI command: ${action}/${input.action||''}`);
   const record={action,...(action==='uiCommand'?{command:input.action,input:structuredClone(input.input)}:{})};commands.push(record);
   const oldAppend=journal.append,oldSave=a.save;
   try{
    if(action==='stateView'&&mode==='refresh-failure'&&acknowledged)throw Error('OFFLINE_REFRESH_FAILURE');
    if(action==='uiCommand'&&mode==='before-commit-failure')journal.append=()=>{throw Error('OFFLINE_BEFORE_COMMIT_FAILURE');};
    if(action==='uiCommand'&&mode==='projection-failure')a.save=()=>{throw Error('OFFLINE_PROJECTION_FAILURE');};
    const data=await a.dispatch(action,input);record.ok=true;
    if(action==='uiCommand'){record.ack=taskState(a,taskId);acknowledged=true;}
    return {data};
   }catch(error){record.ok=false;record.error=error.message;record.committed=error.committed===true;return {error:error.message,code:error.code,committed:error.committed};}
   finally{journal.append=oldAppend;a.save=oldSave;}
  });
  await page.goto(server.resolvedUrls.local[0]);await page.getByLabel('搜索事项').fill(task.title);
  await page.locator('.task-card').filter({has:page.getByRole('heading',{name:task.title,exact:true})}).click();
  await expect(page.getByRole('dialog')).toContainText(task.title);
  await page.getByRole('button',{name:'验收完成',exact:true}).click();
  if(mode==='normal'){
   await expect(page.getByText('事项已验收完成',{exact:true})).toBeVisible();
   await expect(page.getByText('已完成并保存结果',{exact:true})).toBeVisible();
  }else{
   await expect(page.locator('.toast')).toContainText(mode==='before-commit-failure'?'OFFLINE_BEFORE_COMMIT_FAILURE':'已保存，后续处理未完成');
   await expect(page.getByText('事项已验收完成',{exact:true})).toHaveCount(0);
   if(mode==='before-commit-failure')await expect(page.getByRole('button',{name:'验收完成',exact:true})).toBeEnabled();
  }
  const after=taskState(a,taskId),disk=JSON.parse(fs.readFileSync(a.file,'utf8')).tasks.find(row=>row.id===taskId),ui={successToast:await page.getByText('事项已验收完成',{exact:true}).count()>0,completedLabel:await page.getByText('已完成并保存结果',{exact:true}).count()>0};
  assert.equal(commands.filter(row=>row.action==='uiCommand').length,1,'A UI click must send exactly one acceptance');
  assert.deepEqual(a.data.tasks.filter(row=>row.id!==taskId).map(row=>taskState(a,row.id)),otherStates,'Acceptance must preserve every other task identity');
  assert.deepEqual(errors,[]);assert.deepEqual(transports,[]);assert.equal((a.data.modelCalls||[]).length,originalModelCalls);
  dispose(a);restarted=make();const restart=taskState(restarted,taskId);
  if(mode==='before-commit-failure'){assert.deepEqual(after,before);assert.equal(restart.status,'review');assert.equal(restart.acceptedEvents.length,0);}
  else {assert.equal(after.status,'completed');assert.equal(after.acceptedEvents.length,1);assert.equal(after.acceptanceHistory.length,1);assert.deepEqual(restart,after);assert.equal(after.acceptanceHistory[0].eventId,after.acceptedEvents[0].eventId);}
  if(['normal','refresh-failure'].includes(mode))assert.equal(disk.acceptedAt,after.acceptedAt);
  if(mode==='projection-failure'){assert.equal(disk.status,'review');assert.equal(commands.find(row=>row.action==='uiCommand').committed,true);}
  assert.equal((restarted.data.modelCalls||[]).length,originalModelCalls);assert.deepEqual(transports,[]);
  // Reload the actual App against a fresh backend, not merely its old live state.
  a=restarted;acknowledged=false;
  await page.reload();await page.getByLabel('搜索事项').fill(task.title);
  await page.locator('.task-card').filter({has:page.getByRole('heading',{name:task.title,exact:true})}).click();
  if(mode==='before-commit-failure')await expect(page.getByRole('button',{name:'验收完成',exact:true})).toBeEnabled();
  else await expect(page.getByText('已完成并保存结果',{exact:true})).toBeVisible();
  assert.equal(commands.filter(row=>row.action==='uiCommand').length,1,'Restart must not replay the UI command');
  assert.deepEqual(errors,[]);assert.deepEqual(transports,[]);assert.deepEqual(externalBrowserRequests,[]);
  for(const[name,hash]of Object.entries(sourceHashes))assert.equal(sha(path.join(workspace,name)),hash,'Original sealed input changed');
  return {kind:'offline-automated-ui-diagnostic',harness:'Actual React App and Assistant backend; isolated test bridge replaces Electron IPC',mode,passed:true,sourceHashes,selectedTask:{id:taskId,title:task.title},before,ui,commands:commands.filter(row=>row.action==='uiCommand'),after,persistedBeforeRestart:{status:disk.status,acceptedAt:disk.acceptedAt||null},restart,uiAfterRestartVerified:true,otherTaskIdentitiesUnchanged:true,modelCallsAdded:0,externalTransportAttempts:transports.length,externalBrowserRequestAttempts:externalBrowserRequests.length,humanAcceptance:false,historicalCauseIdentified:false};
 }finally{
  await browser?.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve));dispose(a);dispose(restarted);
  const relative=path.relative(tempRoot,fs.realpathSync(directory));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
}
module.exports={run,validateOutput};
if(require.main===module){
 const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,list)=>{if(value.startsWith('--'))pairs.push([value.slice(2),list[index+1]]);return pairs;},[]));
 Promise.resolve().then(async()=>{const output=args.out?validateOutput(args.out,args.workspace):null,result=await run({workspace:args.workspace,taskId:args['task-id'],mode:args.mode}),text=JSON.stringify(result,null,2)+'\n';if(output)fs.writeFileSync(output,text,{flag:'wx'});else process.stdout.write(text);}).catch(error=>{console.error(error.stack);process.exitCode=1;});
}
