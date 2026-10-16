const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),outputs=require('../desktop/deliverables.cjs'),access=require('../desktop/protocol-access.cjs');
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-output-protocol-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir});await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
 const task=a.createTask({title:'交接',criteria:'补齐证据，交付业务主稿',generationMode:'single',steps:[{title:'修订正文',kind:'draft'},{title:'保存',kind:'external'}]});
 const job=agent.buildJob(a,{goal:'完成交接',autoAccept:false,allowWeb:false});a.data.delegations.push(job);job.taskIds=[task.id];task.agentJobId=job.id;
 return {a,task,job,step:task.steps[0]};
}
function add(f,id,content='业务主文'){
 const artifact={id,taskId:f.task.id,stepId:f.step.id,title:id,content,createdAt:'2026-01-01T00:00:00Z'};f.a.data.artifacts.push(artifact);access.retain(f.a,'artifact',artifact,{task:f.task,job:f.job});return artifact;
}
test('supporting output in the same draft slot keeps the explicitly selected primary body and context',async t=>{
 const f=await setup(t),main=add(f,'main');outputs.bind(f.a,f.task,main.id);f.step.outputRole='supporting';f.step.title='核验报告';
 f.a.call=async()=>({kind:'artifact',title:'辅助核验',content:'检查发现仍有缺口。'});await f.a.advance(f.task.id);
 assert.equal(outputs.primary(f.a,f.task).id,'main');assert.notEqual(f.step.artifactId,'main');
 const current=outputs.current(f.a,f.task);assert.equal(current.length,2);assert.equal(outputs.role(f.a,f.task,current.find(x=>x.id===f.step.artifactId)),'supporting');
 const context=f.a.context(f.task,{verification:true});assert.equal(context.artifacts.find(x=>x.id==='main').content,'业务主文');assert.equal(context.artifacts.find(x=>x.id==='main').role,'primary');
 const group=require('../desktop/results.cjs').overview(f.a).groups.find(g=>g.taskId===f.task.id);assert.equal(group.primaryId,'main');assert.ok(group.current.some(r=>r.id==='main'));assert.ok(!group.history.some(r=>r.id==='main'));
 assert.equal(f.a.data.agentActions.length,0);
 f.a.save();const reopened=new Assistant({dir:f.a.dir});assert.equal(outputs.primary(reopened,reopened.task(f.task.id)).id,'main');
});
test('explicit historical primary target wins over the latest auxiliary draft when revising',async t=>{
 const f=await setup(t),main=add(f,'main','已知事实。\n缺少链接。');add(f,'auxiliary','这不是交接正文。');outputs.bind(f.a,f.task,main.id);Object.assign(f.step,{outputRole:'primary',targetArtifactId:'main'});
 f.a.call=async(role,p,c)=>{assert.equal(c.revision.artifactId,'main');assert.equal(c.revision.originalContent,main.content);return {kind:'patch',edits:[{before:'缺少链接。',after:'已核对的链接。'}],summary:'仅补链接'};};
 await f.a.advance(f.task.id);const next=outputs.primary(f.a,f.task);assert.equal(next.content,'已知事实。\n已核对的链接。');assert.equal(main.content,'已知事实。\n缺少链接。');assert.equal(f.step.targetArtifactId,next.id);assert.equal(next.outputRole,'primary');
});
test('explicit binding fails closed for foreign, duplicate or withdrawn artifacts',async t=>{
 const f=await setup(t),main=add(f,'main');outputs.bind(f.a,f.task,'main');const foreign=add(f,'foreign');foreign.taskId='other';assert.throws(()=>outputs.bind(f.a,f.task,'foreign'));
 main.deleted=true;assert.equal(outputs.primary(f.a,f.task),null);assert.throws(()=>outputs.select(f.a,f.task));main.deleted=false;f.a.data.artifacts.push({...main});assert.throws(()=>outputs.bind(f.a,f.task,'main'));
});
test('worker hands missing external evidence back to Agent without a human question or placeholder artifact',async t=>{
 const f=await setup(t);let calls=0;f.a.call=async(role,p)=>{calls++;assert.match(p,/needs_evidence/);return {kind:'needs_evidence',summary:'需要查询目标实体',gaps:['缺少目标实体专项回执'],requirements:['task:'+f.task.id]};};
 await f.a.advance(f.task.id);assert.equal(calls,1);assert.equal(f.task.status,'todo');assert.equal(f.step.done,false);assert.equal(f.task.evidenceRequest.kind,'needs_evidence');assert.equal(f.a.data.artifacts.length,0);assert.equal(f.a.data.decisions.length,0);assert.equal(f.task.waitingOn,'');
});
test('section generation preserves completed text when the next section requires new evidence',async t=>{
 const f=await setup(t);f.task.generationMode='sections';let calls=0;f.a.call=async()=>[ {title:'交接',sections:['已有事实','目标映射']},{kind:'artifact',content:'已有事实保留。'},{kind:'needs_evidence',summary:'补查目标映射',gaps:['映射尚无实际回执']} ][calls++];
 await f.a.advance(f.task.id);assert.equal(f.step.checkpoint.sections[0].content,'已有事实保留。');assert.equal(f.step.checkpoint.sections[1].content,null);assert.equal(f.step.done,false);assert.equal(f.task.evidenceRequest.kind,'needs_evidence');assert.equal(f.a.data.artifacts.length,0);
});
test('changing a selected target during generation rejects the late patch and preserves the main binding',async t=>{
 const f=await setup(t),main=add(f,'main','原文。');add(f,'other','另一份。');outputs.bind(f.a,f.task,main.id);Object.assign(f.step,{outputRole:'primary',targetArtifactId:'main'});
 f.a.call=async()=>{f.step.targetArtifactId='other';return {kind:'patch',edits:[{before:'原文。',after:'修改。'}]};};await f.a.advance(f.task.id);assert.equal(f.task.status,'blocked');assert.equal(outputs.primary(f.a,f.task).id,'main');assert.equal(main.content,'原文。');
});
