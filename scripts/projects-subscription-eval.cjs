const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {Assistant}=require('../desktop/core.cjs'),subscription=require('../desktop/subscription.cjs');
const output=path.resolve(process.argv[2]||'artifacts/projects/subscription');if(fs.existsSync(path.join(output,'report.json')))throw new Error('使用新的测试结果目录');fs.mkdirSync(output,{recursive:true});
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v05-real-'))),resultDir=path.join(dir,'output');fs.mkdirSync(resultDir);
const a=new Assistant({dir:path.join(dir,'workspace')});let job;
const report={startedAt:new Date().toISOString(),provider:'production Codex subscription provider',status:'running',stages:[]};
const save=()=>{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({...report,calls:job?.callsUsed,usage:job?.usage},null,2));fs.writeFileSync(path.join(output,'workspace-evidence.json'),JSON.stringify(a.publicState(),null,2));};
const deadline=setTimeout(()=>a.stop(),15*60*1000);
const source=(file,title)=>({title,base64:fs.readFileSync(path.join(__dirname,'../tests/fixtures',file)).toString('base64')});
async function finishStage(name){const start=Date.now();for(let i=0;i<8;i++){await a.runPromise;save();console.log(JSON.stringify({stage:name,status:job.status,calls:job.callsUsed}));if(job.status==='completed')break;if(job.status!=='ready')throw new Error(`${name}: ${job.status}: ${job.summary}`);await a.dispatch('agentRun',{id:job.id});}assert.equal(job.status,'completed');report.stages.push({name,passed:true,calls:job.callsUsed,durationMs:Date.now()-start,tasks:job.taskIds.length});save();}
(async()=>{try{
 const detected=await subscription.status();assert.equal(detected.loggedIn,true);report.model=detected.model;report.reasoning=detected.reasoning;report.cli=detected.version;
 await a.dispatch('saveProvider',{name:'当前订阅',type:'codex',model:detected.model,reasoning:detected.reasoning});a.data.agentSettings.outputFolder=resultDir;
 await a.dispatch('projectSave',{name:'极光发布',background:'依据最新材料维护一份中文发布计划，列出来源页码或段落。收到修订时继续更新同一事项、同一份报告，保留历史版本。'});const p=a.data.projects[0];
 await a.dispatch('importDocuments',{projectId:p.id,items:[source('project.pdf','发布说明.pdf'),source('project.docx','发布要求.docx')]});
 await a.dispatch('agentCreate',{projectId:p.id,goal:'根据项目材料整理一份简短的中文极光发布计划，包含发布日期、负责人、预算、验收清单及风险，引用材料名称和页码或段落，保存 Markdown 到指定目录。收到后续修订后继续更新这一份报告。',allowWeb:false,folderIds:[],useOutputFolder:true,fileMode:'auto',githubMode:'off',maxCalls:35,maxActions:8,autoAccept:true});job=a.data.delegations[0];await finishStage('PDF 与 Word 首次交付');const originalIds=[...job.taskIds];
 await a.dispatch('importDocuments',{projectId:p.id,items:[source('project-updated.docx','发布要求.docx')]});await a.dispatch('agentRun',{id:job.id});await finishStage('Word 修订归并并再次交付');
 assert.deepEqual(job.taskIds,originalIds);assert.equal(a.data.delegations.length,1);const done=a.data.agentActions.filter(r=>r.status==='done'&&r.tool==='write_file');assert.ok(done.length>=2);const latest=fs.readFileSync(done.at(-1).result.latestPath,'utf8');assert.match(latest,/22/);assert.match(latest,/3[,]?800/);assert.match(latest,/段|页/);for(const name of fs.readdirSync(resultDir))if(fs.statSync(path.join(resultDir,name)).isFile())fs.copyFileSync(path.join(resultDir,name),path.join(output,name));report.status='completed';report.passed=true;report.checks=['实际读取 PDF 与 Word','正式订阅提供商完成真实模型调用','再次导入复用同一事项和委托','实际文件包含新版日期、预算、来源定位','旧产出与归并记录保留'];
 }catch(e){a.stop();report.status='failed';report.error=e.message;process.exitCode=1;}finally{clearTimeout(deadline);report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({...report,calls:job?.callsUsed}));fs.rmSync(dir,{recursive:true,force:true});}})();
