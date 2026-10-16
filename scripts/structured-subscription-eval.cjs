// Real current subscription; local temporary files only, no external tool writes.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Assistant,modelChat}=require('../desktop/core.cjs'),subscription=require('../desktop/subscription.cjs'),formats=require('../desktop/delivery-format.cjs');
const out=path.resolve(process.argv[2]||'artifacts/v10/structured-subscription');
if(fs.existsSync(path.join(out,'report.json')))throw new Error('Choose a fresh report directory');fs.mkdirSync(out,{recursive:true});
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v10-structured-'))),delivery=path.join(dir,'delivery');fs.mkdirSync(delivery);
const report={startedAt:new Date().toISOString(),status:'running',checks:[],actualCalls:0,stages:[],externalMessages:0};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));let a;
const timeout=setTimeout(()=>a?.stop(),15*60*1000);
(async()=>{try {
  const provider=await subscription.status();assert.equal(provider.loggedIn,true);Object.assign(report,{model:provider.model,reasoning:provider.reasoning});save();
  a=new Assistant({dir:path.join(dir,'workspace'),chat:async(p,k,m,o)=>{report.actualCalls++;report.stages.push(o.stage);save();return modelChat(p,k,m,o);},agentRequest:async()=>{throw new Error('本地结构化测试未授权外部访问');}});
  await a.dispatch('saveProvider',{name:'当前订阅模型',type:'codex',model:provider.model,reasoning:provider.reasoning});await a.dispatch('stewardshipSettings',{dailyCallLimit:32});a.data.agentSettings.outputFolder=delivery;
  await a.dispatch('projectSave',{name:'青禾结构化交付验证'});const project=a.data.projects[0];
  await a.dispatch('import',{items:[{title:'已确认结构化要求',projectId:project.id,content:'项目简称是青禾，交付日期 2026-10-12，预算 4800 元，预算调整数 -12.5 元。这些数字和格式均已确认，不需要再询问。JSON 使用 project、date、budget、adjustment 四个字段，budget 和 adjustment 是数字。CSV 使用 project,budget,adjustment 三列和一条青禾数据行，须保留负数调整值。仅生成这两个文件，内容不含说明文字、Markdown 标题或围栏。'}]});
  await a.dispatch('agentCreate',{projectId:project.id,goal:'根据项目已确认材料，分别创建两个事项，在授权目录实际交付 qinghe.json 与 qinghe.csv，并验收。JSON 和 CSV 各自一个事项、一个生成正文步骤和一个实际保存步骤。原样保存正确的目标格式正文，不生成 Markdown 报告或其他文件；无需联网、联系他人或再确认。',allowWeb:false,folderIds:[],useOutputFolder:true,fileMode:'auto',useGithub:false,maxCalls:32,maxActions:12,autoAccept:true});await a.runPromise;
  const job=a.data.delegations.find(j=>j.id===project.jobId);for(let n=0;n<5&&['ready','retry'].includes(job.status);n++){await a.dispatch('agentRun',{id:job.id});await a.runPromise;}
  assert.equal(job.status,'completed',`${job.status}: ${job.lastError||job.summary}`);assert.equal(job.taskIds.length,2);
  const records=a.data.agentActions.filter(r=>r.jobId===job.id&&r.tool==='write_file'&&r.status==='done');
  const json=records.findLast(r=>r.latestName==='qinghe.json'),csv=records.findLast(r=>r.latestName==='qinghe.csv');assert.ok(json&&csv);
  const jsonText=fs.readFileSync(json.result.latestPath,'utf8'),csvText=fs.readFileSync(csv.result.latestPath,'utf8');
  assert.deepEqual(JSON.parse(jsonText),{project:'青禾',date:'2026-10-12',budget:4800,adjustment:-12.5});
  assert.deepEqual(formats.validate(csvText,'csv'),{format:'csv',rows:2,columns:3});assert.match(csvText,/青禾/);assert.match(csvText,/4800/);assert.match(csvText,/-12\.5/);assert.equal(json.result.format,'json');assert.equal(csv.result.format,'csv');
  for(const record of [json,csv]){assert.equal(fs.readFileSync(record.result.path,'utf8'),fs.readFileSync(record.result.latestPath,'utf8'));assert.equal(record.content,a.data.artifacts.find(r=>r.id===record.artifactId).content);assert.equal(record.result.verified,true);assert.equal(a.task(record.taskId).verification.passed,true);}
  fs.writeFileSync(path.join(out,'qinghe.json'),jsonText);fs.writeFileSync(path.join(out,'qinghe.csv'),csvText);
  report.checks.push('当前订阅模型自主生成两个事项和对应格式正文','JSON 严格解析且字段和数字类型符合已确认资料','CSV 为三列两行，保留负数，无公式和额外说明','当前产出、历史版本、指定文件逐字一致，真实回读与独立验收通过');
  const calls=report.actualCalls,brief=await a.dispatch('projectReport',{projectId:project.id,includeArtifactContent:true});assert.equal(report.actualCalls,calls);assert.equal(brief.progress.completed,2);assert.equal(brief.deliveries.filter(r=>[json.id,csv.id].includes(r.id)).length,2);fs.writeFileSync(path.join(out,'project-report.md'),brief.markdown);report.checks.push('项目简报汇总两份已验收交付且无额外模型调用');
  Object.assign(report,{passed:true,status:'completed',tasks:job.taskIds.length,usage:job.usage,files:[json.latestName,csv.latestName]});
}catch(error){Object.assign(report,{passed:false,status:'failed',error:error.stack||error.message});process.exitCode=1;}
finally{clearTimeout(timeout);if(a)fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(a.publicState(),null,2));report.finishedAt=new Date().toISOString();report.durationMs=Date.parse(report.finishedAt)-Date.parse(report.startedAt);save();console.log(JSON.stringify(report));a?.stop();await a?.runPromise;fs.rmSync(dir,{recursive:true,force:true});}})();
