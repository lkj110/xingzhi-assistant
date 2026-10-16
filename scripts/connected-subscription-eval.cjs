const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {Assistant}=require('../desktop/core.cjs'),subscription=require('../desktop/subscription.cjs'),agent=require('../desktop/agent.cjs');
const out=path.resolve(process.argv[2]||'artifacts/connected/subscription');if(fs.existsSync(path.join(out,'report.json')))throw new Error('请使用新的结果目录');fs.mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),provider:'production Codex subscription provider',runs:[],status:'running'};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
let a;const timeout=setTimeout(()=>a?.stop(),15*60*1000);
(async()=>{try{
 const detected=await subscription.status();assert.equal(detected.loggedIn,true);Object.assign(report,{model:detected.model,reasoning:detected.reasoning,cli:detected.version});save();
 for(const compact of [false,true]){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v06-subscription-'))),output=path.join(dir,'delivery');fs.mkdirSync(output);
  try{
   a=new Assistant({dir:path.join(dir,'workspace')});await a.dispatch('saveProvider',{name:'当前订阅',type:'codex',model:detected.model,reasoning:detected.reasoning});await a.dispatch('settings',{compactContext:compact});a.data.agentSettings.outputFolder=output;
   await a.dispatch('projectSave',{name:'极光发布',background:'从提供的文档生成中文发布简报，日期不含年份时保留不确定性。'});const p=a.data.projects[0];
   await a.dispatch('importDocuments',{projectId:p.id,items:['project.pdf','project.docx'].map((file,i)=>({title:i?'发布要求.docx':'发布说明.pdf',base64:fs.readFileSync(path.join(__dirname,'../tests/fixtures',file)).toString('base64')}))});
   const j=agent.buildJob(a,{projectId:p.id,goal:'根据项目材料生成一份不超过 600 字的中文发布简报，包含发布日期、负责人、预算、验收清单与风险，引用材料名称及页码或段落，保存 Markdown 到指定目录。只需要一份简报。',allowWeb:false,folderIds:[],useOutputFolder:true,fileMode:'auto',githubMode:'off',maxCalls:24,maxActions:12,autoAccept:true});p.jobId=j.id;a.data.delegations.push(j);require('../desktop/projects.cjs').ingest(a,p,{checkpoint:false});
   const original=JSON.stringify(agent.context(a,j,{full:true})).length,compactChars=JSON.stringify(agent.context(a,j)).length;
   const start=Date.now();await a.dispatch('agentRun',{id:j.id});for(let n=0;n<5;n++){await a.runPromise;fs.writeFileSync(path.join(out,compact?'compact-evidence.json':'full-evidence.json'),JSON.stringify(a.publicState(),null,2));console.log(JSON.stringify({mode:compact?'compact':'full',status:j.status,calls:j.callsUsed,error:j.lastError}));if(j.status==='completed')break;if(!['ready','retry'].includes(j.status))throw new Error(`${j.status}: ${j.summary}: ${j.lastError}`);if(j.status==='retry')await new Promise(r=>setTimeout(r,Math.max(0,Date.parse(j.nextRunAt)-Date.now())));await a.dispatch('agentRun',{id:j.id});}
   assert.equal(j.status,'completed');assert.equal(j.taskIds.length,1);const writes=a.data.agentActions.filter(r=>r.status==='done'&&r.tool==='write_file');assert.ok(writes.length);const content=fs.readFileSync(writes.at(-1).result.latestPath,'utf8');assert.match(content,/18/);assert.match(content,/4[,]?500/);assert.match(content,/页|段/);
   const mode=compact?'compact':'full';fs.writeFileSync(path.join(out,`${mode}-delivery.md`),content);fs.writeFileSync(path.join(out,`${mode}-evidence.json`),JSON.stringify(a.publicState(),null,2));
   report.runs.push({mode,passed:true,calls:j.callsUsed,durationMs:Date.now()-start,inputChars:a.data.modelCalls.reduce((n,c)=>n+c.inputChars,0),initialContextChars:compactChars,uncompressedContextChars:original,usage:j.usage,callsDetail:a.data.modelCalls,repeatedActions:j.repeatedActions||0});save();
  }finally{if(a)fs.writeFileSync(path.join(out,compact?'compact-evidence.json':'full-evidence.json'),JSON.stringify(a.publicState(),null,2));a?.stop();await a?.runPromise;fs.rmSync(dir,{recursive:true,force:true});}
 }
 report.passed=true;report.status='completed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}finally{clearTimeout(timeout);report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,error:report.error,runs:report.runs.map(({callsDetail,...r})=>r)}));}})();
