// Real configured subscription model; all Feishu transport is an isolated fixture.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),connectors=require('../desktop/connectors.cjs'),subscription=require('../desktop/subscription.cjs');
const pinnedFixture=require('../tests/helpers/lark-pinned-fixture.cjs');
const out=path.resolve(process.argv[2]||'artifacts/collaboration/subscription');if(fs.existsSync(path.join(out,'report.json')))throw new Error('Use a fresh output directory');fs.mkdirSync(out,{recursive:true});
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v07-subscription-'))),delivery=path.join(dir,'delivery');fs.mkdirSync(delivery);
const report={startedAt:new Date().toISOString(),status:'running',transport:'模拟飞书会话；未向真实会话发送消息',phases:[]};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const messages=[{message_id:'om_initial',chat_id:'oc_fixture',content:'本次发布请先向我确认是否周六发布。',msg_type:'text',sender:{id:'ou_owner',name:'测试负责人'},create_time:new Date(Date.now()-3600000).toISOString()}],posts=[];
const request=async args=>{
  const flag=k=>args[args.indexOf(k)+1];
  if(args[0]==='auth')return {verified:true,identities:{user:{available:true,status:'ready',openId:'ou_self'}}};
  if(args[1]==='+chat-messages-list')return {data:{messages,has_more:false}};
  if(args[1]==='+messages-send'){assert.equal(flag('--chat-id'),'oc_fixture');const m={message_id:`om_sent${posts.length+1}`,chat_id:'oc_fixture',content:flag('--text'),msg_type:'text',sender:{id:'ou_self',name:'助手本人'},create_time:new Date().toISOString()};posts.push(m);return {data:{message_id:m.message_id,chat_id:m.chat_id}};}
  if(args[1]==='+messages-mget')return {data:{messages:posts.filter(m=>m.message_id===flag('--message-ids'))}};
  throw new Error('Unexpected fixture command');
};
let a,j;const fixtureCleanup=[];const timeout=setTimeout(()=>a?.stop(),15*60*1000);
(async()=>{try{
  const provider=await subscription.status();assert.equal(provider.loggedIn,true);Object.assign(report,{model:provider.model,reasoning:provider.reasoning,cli:provider.version});save();
  a=new Assistant({dir:path.join(dir,'workspace'),connectorRequest:request});await pinnedFixture.attach({after:cleanup=>fixtureCleanup.push(cleanup)},a,request);await a.dispatch('saveProvider',{name:'当前订阅',type:'codex',model:provider.model,reasoning:provider.reasoning});a.data.agentSettings.outputFolder=delivery;
  await a.dispatch('projectSave',{name:'发布确认测试'});const p=a.data.projects[0];
  j=agent.buildJob(a,{projectId:p.id,goal:'完成一项发布确认工作：使用本项目飞书会话，以原文“请确认是否周六发布。”向 ou_owner 询问，等待该负责人明确确认周六发布；含糊回复需要继续等待。收到明确确认后生成一份不超过 150 字的发布确认记录并保存 Markdown 到指定产出目录，引用回复消息。整个工作用一个事项，必要时在同一事项中安排确认、写作和保存步骤。',allowWeb:false,folderIds:[],useOutputFolder:true,fileMode:'auto',maxCalls:40,maxActions:12,autoAccept:true});p.jobId=j.id;a.data.delegations.push(j);
  await a.dispatch('connectorSave',{name:'发布确认会话',kind:'chat',target:'oc_fixture',projectId:p.id,enabled:true});const c=a.data.connectors[0];await pinnedFixture.bind(a,c);
  await a.dispatch('communicationPolicy',{connectorId:c.id,mode:'auto',template:'请确认是否周六发布。',intervalMinutes:60,maxSends:2,expiresAt:new Date(Date.now()+86400000).toISOString()});await connectors.sync(a,c.id);
  async function runUntil(state){for(let n=0;n<6;n++){await a.dispatch('agentRun',{id:j.id});await a.runPromise;fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(a.publicState(),null,2));console.log(JSON.stringify({status:j.status,calls:j.callsUsed,posts:posts.length,error:j.lastError}));if(j.status===state)return;if(!['ready','retry'].includes(j.status))throw new Error(`${j.status}: ${j.lastError||j.summary}`);}throw new Error('Too many rounds');}
  await runUntil('watching');assert.equal(posts.length,1);report.phases.push({name:'自主规划、按固定文案发送并等待',passed:true,calls:j.callsUsed});save();
  messages.push({message_id:'om_vague',chat_id:'oc_fixture',content:'收到，我稍后再确认。',msg_type:'text',sender:{id:'ou_owner',name:'测试负责人'},create_time:new Date().toISOString()});await connectors.sync(a,c.id);await runUntil('watching');assert.ok(j.followups.some(f=>f.status==='waiting'));assert.equal(posts.length,1);report.phases.push({name:'含糊回复保持等待，不重复发消息',passed:true,calls:j.callsUsed});save();
  messages.push({message_id:'om_confirmed',chat_id:'oc_fixture',content:'确认，本次发布安排在周六，可以按此推进。',msg_type:'text',sender:{id:'ou_owner',name:'测试负责人'},create_time:new Date().toISOString()});await connectors.sync(a,c.id);await runUntil('completed');
  assert.equal(posts.length,1);assert.equal(j.taskIds.length,1);assert.ok(j.followups.some(f=>f.status==='resolved'&&a.data.sources.find(s=>s.id===f.sourceId)?.remoteId==='om_confirmed'));
  const file=a.data.agentActions.findLast(r=>r.tool==='write_file'&&r.status==='done');assert.ok(file);const content=fs.readFileSync(file.result.latestPath,'utf8');assert.match(content,/周六/);fs.writeFileSync(path.join(out,'delivery.md'),content);
  report.phases.push({name:'明确回复经独立核验后续办并交付文件',passed:true,calls:j.callsUsed});Object.assign(report,{status:'completed',passed:true,calls:j.callsUsed,usage:j.usage,outgoingMessages:posts.length,tasks:j.taskIds.length});
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}finally{clearTimeout(timeout);if(a)fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(a.publicState(),null,2));report.finishedAt=new Date().toISOString();report.durationMs=Date.parse(report.finishedAt)-Date.parse(report.startedAt);save();console.log(JSON.stringify(report));a?.stop();try{await a?.runPromise;}finally{try{for(const cleanup of fixtureCleanup.reverse())await cleanup();}finally{fs.rmSync(dir,{recursive:true,force:true});}}}})();
