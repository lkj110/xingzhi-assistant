const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {present}=require('../desktop/delivery-presentation.cjs'),{overview}=require('../desktop/results.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(tool='lark_create'){
 const task={id:'task',title:'交付事项',agentJobId:'job',status:'review',sourceIds:[],steps:[{id:'draft',kind:'draft',done:true,artifactId:'main'},{id:'publish',kind:'external',tool,done:true,evidence:JSON.stringify({actionId:'receipt'})}],verification:{passed:true,summary:'检查通过',gaps:[]}};
 const primary={id:'main',taskId:task.id,stepId:'draft',title:'主稿',content:'已核对的正文'};
 const result=tool==='write_file'?{path:'/output/version.md',latestPath:'/output/final.md',hash:hash(primary.content),latestHash:hash(primary.content),format:'md',verified:true}:tool.startsWith('github')?{url:'https://github.com/acme/work/issues/42',number:42,verified:true}:{url:'https://tenant.feishu.cn/docx/Abc123',documentId:'Abc123',submittedHash:hash(primary.content),readbackHash:'readback-hash',verified:true};
 const action={id:'receipt',tool,taskId:task.id,jobId:'job',artifactId:primary.id,content:primary.content,title:task.title,status:'done',target:tool==='write_file'?'/output/version.md':tool.startsWith('github')?'acme/work':'my_library',result};
 const a={data:{tasks:[task],artifacts:[primary],agentActions:[action],delegations:[{id:'job',taskIds:[task.id],outputFolder:'/output'}],sources:[],projects:[],decisions:[]}};
 return {a,task,primary,action};
}
for(const tool of ['lark_create','lark_update','github_create','github_update','write_file'])test(tool+' becomes the delivery entrance with unchanged local primary and zero side effects',()=>{
 const {a,task,primary}=fixture(tool),before=JSON.stringify(a.data),result=present(a,task,primary),group=overview(a).groups[0];
 assert.equal(result.primary.status,'saved');assert.equal(group.delivery.actionId,'receipt');assert.equal(group.primaryId,'main');assert.equal(group.current.length,1);assert.equal(JSON.stringify(a.data),before);
});
test('A local save followed by Lark delivery promotes the last requested destination and retains other locations',()=>{
 const {a,task,primary,action}=fixture(),file=fixture('write_file').action;file.id='file';a.data.agentActions.unshift(file);task.steps.splice(1,0,{id:'save',kind:'external',tool:'write_file',done:true,evidence:JSON.stringify({actionId:'file'})});
 const result=present(a,task,primary);assert.equal(result.primary.actionId,action.id);assert.equal(result.others[0].actionId,'file');
});
test('A final requested file wins over a previous remote document; array order and prose do not choose it',()=>{
 const {a,task,primary,action}=fixture(),file=fixture('write_file').action;file.id='file';a.data.agentActions.unshift(file);task.steps.push({id:'save',kind:'external',tool:'write_file',done:true,evidence:JSON.stringify({actionId:'file'})});
 assert.equal(present(a,task,primary).primary.kind,'file');
});
for(const change of ['foreignTask','foreignJob','oldArtifact','contentChanged','hashChanged','wrongDoc','unsafeURL','noReadback','unverified','uncertain','deliveryConflict'])test('Invalid Lark receipt cannot become final: '+change,()=>{
 const {a,task,primary,action}=fixture();
 ({foreignTask:()=>action.taskId='other',foreignJob:()=>action.jobId='other',oldArtifact:()=>action.artifactId='old',contentChanged:()=>primary.content+=' changed',hashChanged:()=>action.result.submittedHash='old',wrongDoc:()=>action.result.documentId='Other',unsafeURL:()=>action.result.url='https://evil.invalid/docx/Abc123',noReadback:()=>delete action.result.readbackHash,unverified:()=>action.result.verified=false,uncertain:()=>action.status='uncertain',deliveryConflict:()=>action.deliveryConflict={observationId:'external-update'}})[change]();
 const result=present(a,task,primary);assert.equal(result.primary.status,'pending');assert.equal(result.primary.url,undefined);assert.equal(result.others.length,0);
});
test('Model summary/source URL alone is never an external delivery',()=>{
 const {a,task,primary}=fixture();a.data.agentActions=[];task.verification.summary='已创建 https://tenant.feishu.cn/docx/Abc123';assert.equal(present(a,task,primary).primary.status,'pending');task.steps.pop();assert.equal(present(a,task,primary).primary,null);
});
test('Unfinished final delivery does not promote a valid earlier local save',()=>{
 const {a,task,primary}=fixture(),file=fixture('write_file').action;file.id='file';a.data.agentActions.push(file);task.steps[1].done=false;const result=present(a,task,primary);assert.equal(result.primary.status,'pending');assert.equal(result.others[0].kind,'file');
});
test('Later uncertain update suppresses prior success and resolves to the newly referenced receipt',()=>{
 const {a,task,primary,action}=fixture(),update=structuredClone(action);update.id='update';update.tool='lark_update';update.status='uncertain';a.data.agentActions.push(update);assert.equal(present(a,task,primary).primary.status,'pending');
 update.status='done';task.steps[1].tool='lark_update';task.steps[1].evidence=JSON.stringify({actionId:'update'});assert.equal(present(a,task,primary).primary.actionId,'update');assert.equal(present(a,task,primary).others.length,0);
});
test('GitHub targets must match repository and issue; private file receipts must match output directory',()=>{
 for(const change of [x=>x.action.target='other/repo',x=>x.action.result.number=1,x=>x.action.result.url='https://github.com.evil.invalid/acme/work/issues/42']){const f=fixture('github_create');change(f);assert.equal(present(f.a,f.task,f.primary).primary.status,'pending');}
 for(const change of [x=>x.action.result.latestPath='/elsewhere/final.md',x=>x.action.result.latestHash='old',x=>x.action.result.path='/output/wrong.md']){const f=fixture('write_file');change(f);assert.equal(present(f.a,f.task,f.primary).primary.status,'pending');}
});
test('Supporting report and its receipts never replace the business draft',()=>{
 const {a,task,primary,action}=fixture();task.steps.push({id:'check',kind:'analysis',done:true,artifactId:'report'});a.data.artifacts.push({id:'report',taskId:task.id,stepId:'check',title:'检查报告',content:'核对记录'});const wrong=structuredClone(action);wrong.id='other';wrong.artifactId='report';wrong.result.url='https://tenant.feishu.cn/docx/Report';wrong.result.documentId='Report';a.data.agentActions.push(wrong);const group=overview(a).groups[0];assert.equal(group.primaryId,primary.id);assert.equal(group.delivery.actionId,action.id);
});
test('Replanning and cancellation do not keep prior delivery marked current',()=>{
 for(const field of ['needsReplan','agentCancelled']){const {a,task,primary}=fixture();task[field]=true;assert.equal(present(a,task,primary).primary,null);assert.equal(overview(a).groups[0].delivery,null);}
});
