const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const options=require('../desktop/decision-options.cjs'),decisions=require('../desktop/decisions.cjs'),agent=require('../desktop/agent.cjs'),access=require('../desktop/access.cjs');
const {Assistant}=require('../desktop/core.cjs');
const choices=[{label:'一页摘要',description:'适合快速浏览，保留关键结论与下一步。',answer:'将当前成果整理为一页摘要。',recommended:true},{label:'完整交接版',description:'适合接手实施，保留操作步骤和证据。',answer:'保留完整的交接说明和可操作步骤。'},{label:'指定章节',description:'告诉助手需要保留哪些章节。',requiresText:true}];
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-questions-'));const a=new Assistant({dir,connectorRequest:async()=>{throw Error('No connector calls');},chat:async()=>{throw Error('No model calls');}});t.after(()=>{access.cancel(a);fs.rmSync(dir,{recursive:true,force:true});});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
 const j=agent.buildJob(a,{goal:'整理一份可阅读的文档',allowWeb:false,fileMode:'off',githubMode:'off'});a.data.delegations.push(j);
 await agent.act(a,j,'plan_task',{key:'doc',title:'整理文档',criteria:'结论有证据',steps:[{key:'draft',kind:'draft',title:'整理'}]});
 const ask=extra=>decisions.ask(a,j,{question:'文档应保留到什么程度？',context:'读者和用途影响文档篇幅。',options:choices,...extra});
 const card=()=>a.publicState().decisionCards.find(d=>d.kind==='question');return {a,j,task:a.task(j.taskIds[0]),ask,card};
}
test('Question options are deduplicated, limited to three and have one stable recommendation',()=>{
 const normalized=options.normalize([...choices,{...choices[0]},{label:'额外方案',description:'额外说明'}]);assert.equal(normalized.length,3);assert.equal(normalized.filter(o=>o.recommended).length,1);assert.deepEqual(normalized,options.normalize(normalized));
 assert.equal(options.normalize(choices.map(o=>({...o,recommended:true}))).filter(o=>o.recommended).length,1);
});
test('Malformed or absent choices use safe input methods instead of guessing facts',()=>{
 for(const value of [null,{},'unknown',[],[null,{},5,{label:'other',description:'custom'},{label:'不完整'}]]){const result=options.present({question:'负责人和日期是什么？',options:value});assert.equal(result.options.length,2);assert.equal(result.allowCustom,true);assert.equal(result.options[0].requiresText,true);assert.match(result.options[1].answer,/不能因此宣称完整完成/);}
 assert.equal(options.normalize([], '使用当前已确认的范围')[0].answer,'使用当前已确认的范围');assert.equal(options.normalize([], '使用当前已确认的范围')[0].description,'使用当前已确认的范围');
});
test('Canonical option is recorded, passed to the same task and preserves ledger without a model call',async t=>{
 const {a,j,task,ask,card}=await setup(t);ask();const d=card(),ledger=JSON.stringify(a.spendLedger);j.callsUsed=12;
 await a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,optionId:d.options[0].id,label:'forged label',answer:'给管理层阅读'});
 const saved=a.data.decisions.find(x=>x.id===d.id);assert.equal(saved.answerMode,'option');assert.equal(saved.selectedOption.label,'一页摘要');assert.match(saved.answer,/一页摘要。\n补充说明：给管理层阅读/);assert.match(j.feedback.at(-1).text,/一页摘要/);assert.match(task.notes.at(-1).text,/管理层/);assert.equal(j.status,'ready');assert.equal(j.callsUsed,12);assert.equal(JSON.stringify(a.spendLedger),ledger);assert.deepEqual(j.taskIds,[task.id]);
});
test('Custom text and required-text choices are explicit; unknown IDs and empty input never resume',async t=>{
 const {a,j,ask,card}=await setup(t);ask();const d=card();
 for(const value of [{optionId:'custom',answer:''},{optionId:'forged',answer:'同意'},{optionId:d.options[2].id,answer:''}])await assert.rejects(a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,...value}));
 assert.equal(j.status,'needs_input');assert.equal(a.data.decisions[0].status,'open');
 await a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,optionId:'custom',answer:'保留现状、下一步和负责人三个部分'});assert.equal(a.data.decisions[0].answerMode,'custom');assert.equal(a.data.decisions[0].selectedOption,null);assert.match(j.feedback.at(-1).text,/负责人三个部分/);
});
test('Legacy free-text clients and saved questions remain compatible',async t=>{
 const {a,ask,card}=await setup(t);ask();delete a.data.decisions[0].options;delete a.data.decisions[0].context;const d=card();assert.equal(d.options.length,2);
 await a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,answer:'按照当前范围继续'});assert.equal(a.data.decisions[0].answer,'按照当前范围继续');
});
test('Changing option content invalidates a stale answer even without a timestamp change',async t=>{
 const {a,ask,card}=await setup(t);ask();const old=card();a.data.decisions[0].options[0].answer='改成五页详细报告';
 await assert.rejects(a.dispatch('decisionAnswer',{id:old.id,revision:old.revision,optionId:old.options[0].id}),/变化/);
 const current=card();await assert.rejects(a.dispatch('decisionAnswer',{id:current.id,revision:current.revision,optionId:old.options[0].id}),/方案已变化/);assert.equal(a.data.decisions[0].status,'open');
});
test('Choice answer does not resume a paused job or clear another open question',async t=>{
 const {a,j,ask,card}=await setup(t);ask();const first=card();ask({question:'面向哪些读者？'});j.status='paused';
 await a.dispatch('decisionAnswer',{id:first.id,revision:first.revision,optionId:first.options[0].id});assert.equal(j.status,'paused');assert.equal(a.data.decisions.filter(d=>d.status==='open').length,1);
 j.status='needs_input';const next=card();await a.dispatch('decisionAnswer',{id:next.id,revision:next.revision,answer:'新接手的人'});assert.equal(j.status,'ready');
});
test('Answers cannot bypass uncertain side effects or deleted task checks',async t=>{
 const {a,j,task,ask,card}=await setup(t);ask();let d=card();a.data.agentActions.push({id:'uncertain',jobId:j.id,taskId:task.id,status:'uncertain'});
 await assert.rejects(a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,optionId:d.options[0].id}),/核对/);a.data.agentActions=[];task.deletedAt=new Date().toISOString();d=card();await assert.rejects(a.dispatch('decisionAnswer',{id:d.id,revision:d.revision,answer:'继续'}),/删除|取消/);
});
test('Draft generation preserves structured questions from the model',async t=>{
 const {a,task}=await setup(t);a.chat=async()=>({kind:'need_input',question:'选择篇幅？',context:'篇幅影响交接用途',options:choices});await a.advance(task.id);
 const d=a.publicState().decisionCards.find(d=>d.kind==='question');assert.equal(d.context,'篇幅影响交接用途');assert.equal(d.options.length,3);assert.equal(d.options[2].requiresText,true);
});
test('Standalone drafting supports the same question workflow and preserves pause',async t=>{
 const {a}=await setup(t);const task=a.createTask({title:'独立文档',criteria:'准确'});task.steps=[{id:'write',title:'撰写',kind:'draft',done:false}];a.chat=async()=>({kind:'need_input',question:'选择文档篇幅？',options:choices});await a.advance(task.id);task.status='paused';
 const d=a.publicState().decisionCards.find(d=>d.kind==='task_question');assert.ok(d);await a.dispatch('decisionTaskAnswer',{id:d.id,revision:d.revision,optionId:d.options[1].id});assert.equal(task.status,'paused');assert.equal(task.previousStatus,'todo');assert.equal(a.data.decisions.find(x=>x.id===d.id).selectedOption.label,'完整交接版');
});
test('Deleted standalone tasks cannot accept a stale question answer',async t=>{
 const {a}=await setup(t);const task=a.createTask({title:'独立文档'});task.waitingOn='选择范围';task.status='waiting';decisions.askTask(a,task,{options:choices});const d=a.publicState().decisionCards.find(d=>d.kind==='task_question');task.deletedAt=new Date().toISOString();
 await assert.rejects(a.dispatch('decisionTaskAnswer',{id:d.id,revision:d.revision,answer:'继续'}),/变化|删除/);assert.ok(!a.publicState().decisionCards.some(x=>x.id===d.id));
});
test('Unstructured job blockers gain choices and record a reviewed answer',async t=>{
 const {a,j}=await setup(t);j.status='blocked';j.lastError='读取材料失败';let d=a.publicState().decisionCards.find(d=>d.kind==='blocked');assert.equal(d.context,'读取材料失败');assert.equal(d.options.length,2);
 j.summary='发生了变化';await assert.rejects(a.dispatch('decisionJobAnswer',{id:d.id,revision:d.revision,answer:'新材料在备注'}),/变化/);
 d=a.publicState().decisionCards.find(d=>d.kind==='blocked');await a.dispatch('decisionJobAnswer',{id:d.id,revision:d.revision,optionId:d.options[0].id,answer:'这是新的材料正文'});assert.equal(j.status,'ready');assert.equal(a.data.decisions[0].status,'answered');
});
test('Permission alternatives keep authorization separate from user-provided evidence',async t=>{
 const {a,j,task}=await setup(t);access.request(a,j,{kind:'lark_document',target:'https://example.larkoffice.com/docx/Test'});const d=a.publicState().decisionCards.find(d=>d.kind==='permission'),ledger=JSON.stringify(a.spendLedger);
 await a.dispatch('accessAlternative',{id:d.id,revision:d.revision,mode:'provide_text',answer:'已确认的现状：本周完成了需求评审。'});
 assert.equal(j.documentGrants,undefined);assert.equal(j.allowWeb,false);assert.equal(j.status,'ready');assert.equal(j.callsUsed,0);assert.equal(JSON.stringify(a.spendLedger),ledger);assert.ok(task.sourceIds.includes(a.data.sources[0].id));assert.equal(a.data.sources[0].providedBy,'user');assert.equal(a.data.decisions[0].access.stage,'alternative');assert.match(j.feedback.at(-1).text,/没有新增访问授权/);
});
test('Custom permission response is never counted as credentials and preserves paused work',async t=>{
 const {a,j}=await setup(t);access.request(a,j,{kind:'lark_document',target:'https://example.larkoffice.com/docx/Test'});j.status='paused';const d=a.publicState().decisionCards[0];
 await assert.rejects(a.dispatch('accessAlternative',{id:d.id,revision:'stale',mode:'custom',answer:'同意授权'}),/变化/);
 await a.dispatch('accessAlternative',{id:d.id,revision:d.revision,mode:'custom',answer:'同意授权'});assert.equal(j.status,'paused');assert.equal(j.documentGrants,undefined);assert.equal(a.data.sources.length,0);assert.equal(a.data.decisions[0].status,'answered');
 await assert.rejects(agent.act(a,j,'read_lark_document',{url:'https://example.larkoffice.com/docx/Test'}),e=>e.gateClosed&&e.code==='EXECUTION_GATE_CLOSED');await a.dispatch('agentResume',{id:j.id});
 const result=await agent.act(a,j,'read_lark_document',{url:'https://example.larkoffice.com/docx/Test'});assert.equal(result.needsAuthorization,true);assert.equal(j.documentGrants,undefined);assert.equal(j.callsUsed,0);
});
test('Providing materials cancels an active OAuth session and ignores its late completion',async t=>{
 const {a,j}=await setup(t);access.request(a,j,{kind:'lark_document',target:'https://example.larkoffice.com/docx/Test'});const d=a.publicState().decisionCards[0],controller=new AbortController();a.accessSessions.set(d.id,{controller,jobId:j.id,expiresAt:Date.now()+60000});
 await a.dispatch('accessAlternative',{id:d.id,revision:d.revision,mode:'provide_text',answer:'这里是原文的相关段落'});assert.equal(controller.signal.aborted,true);assert.equal(a.accessSessions.size,0);assert.equal(access.tick(a),false);
});

test('Section planning can ask a structured question before generating an outline',async t=>{
 const {a,task}=await setup(t);task.generationMode='sections';a.chat=async()=>({kind:'need_input',question:'先面向哪类读者？',options:choices});await a.advance(task.id);assert.equal(task.status,'waiting');const d=a.publicState().decisionCards.find(d=>d.kind==='question');assert.equal(d.question,'先面向哪类读者？');assert.equal(d.options.length,3);assert.equal(task.steps[0].done,false);
});
test('Soft deletion cancels a standalone question and restoration does not revive it',async t=>{
 const {a}=await setup(t);const task=a.createTask({title:'独立文档'});task.waitingOn='选择范围';task.status='waiting';decisions.askTask(a,task,{options:choices});const id=a.publicState().decisionCards.find(d=>d.kind==='task_question').id;
 const preview=await a.dispatch('taskTrashPreview',{id:task.id});await a.dispatch('taskTrashDelete',{id:task.id,revision:preview.revision});assert.equal(a.data.decisions.find(d=>d.id===id).status,'cancelled');await a.dispatch('taskTrashRestore',{id:task.id,revision:task.trashRevision});assert.ok(!a.publicState().decisionCards.some(d=>d.id===id));assert.equal(task.status,'paused');
});
