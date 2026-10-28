'use strict';
// No live transport exists in this preparatory tool. Captures source-level first
// inputs only; it is not an installed-EXE lifecycle or semantic acceptance run.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {values}=require('node:util').parseArgs({options:{asar:{type:'string'},git:{type:'string'},verify:{type:'boolean',default:false}}});
const dir=__dirname,root=path.resolve(dir,'../..'),work=path.dirname(root);
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const plan=read('plan.json'),suite=read('stimuli.json'),gold=read('gold.json'),{project}=require('./inputs.cjs');
const sealedFiles=['README.md','plan.json','stimuli.json','gold.json','inputs.cjs','preflight.cjs','anchors.json','novelty.json','preflight.json'];
if(values.verify){
 const seal=read('seal.json');assert.equal(seal.schema,1);assert.equal(seal.id,plan.id);
 assert.deepEqual(seal.files.map(f=>f.path).sort(),[...sealedFiles].sort());
 assert.equal(seal.identity,sha(JSON.stringify(seal.files)));
 assert.equal(seal.liveModelCalls,0);assert.equal(seal.liveAuthorized,false);assert.equal(plan.liveAuthorized,false);
 for(const item of seal.files)assert.equal(sha(fs.readFileSync(path.join(dir,item.path))),item.sha256,item.path);
 console.log(JSON.stringify({sealVerified:true,identity:seal.identity,files:seal.files.length}));process.exit(0);
}
if(fs.existsSync(path.join(dir,'seal.json')))throw Error('Already sealed; use --verify. Amendments require a reviewed new revision, not automatic overwrite.');
assert.ok(values.asar&&path.isAbsolute(values.asar),'--asar must be an absolute installed-ASAR path');
assert.ok(values.git&&path.isAbsolute(values.git),'--git must name the local Git executable');
assert.equal(sha(fs.readFileSync(values.asar)),plan.asarSha256);
assert.equal(cp.execFileSync(values.git,['diff',plan.baseCommit,'--name-only','--','desktop','src','dist','package.json','package-lock.json'],{cwd:root,windowsHide:true}).toString(),'');
assert.equal(plan.liveAuthorized,false);assert.equal(suite.cases.length,6);assert.equal(gold.cases.length,6);
assert.equal(suite.cases.filter(c=>c.lane!=='fixed_invalid').length,4);assert.equal(suite.cases.filter(c=>c.lane==='fixed_invalid').length,2);
assert.equal(new Set(suite.cases.map(c=>c.id)).size,6);assert.equal(new Set(gold.cases.map(c=>c.id)).size,6);
assert.equal(plan.caseLimits.reduce((n,c)=>n+c.attempts,0),plan.budget.businessAttempts);
assert.equal(plan.caseLimits.reduce((n,c)=>n+c.tokenStopThreshold,0),plan.budget.businessTokenStopThreshold);
assert.equal(plan.budget.protocolAttempts+plan.budget.businessAttempts,plan.budget.applicationAttempts);
assert.equal(plan.budget.protocolTokenStopThreshold+plan.budget.businessTokenStopThreshold,plan.budget.reportedTokenStopThreshold);
const anchors=[];
for(const c of suite.cases){
 const g=gold.cases.find(g=>g.id===c.id);assert.ok(g);assert.ok(plan.caseLimits.some(l=>l.id===c.id));
 assert.equal(new Set(c.sources.map(s=>s.key)).size,c.sources.length);
 assert.equal(g.expectedTerminal,c.lane==='fixed_invalid'?'blocked':'review');
 const allowed=project({...c,goldCanary:gold.canary,workflow:[gold.canary],budget:gold.canary,expected:gold.canary});
 assert.deepEqual(Object.keys(allowed).sort(),(c.lane==='fixed_invalid'?['title','description','criteria','sources','candidate']:['title','description','criteria','sources']).sort());
 assert.ok(!JSON.stringify(allowed).includes(gold.canary));
 assert.deepEqual(allowed.sources,c.sources.map(s=>({title:s.title,content:s.content})));
 for(const a of g.assertions){assert.ok(a.evidence.length);for(const e of a.evidence){
  const s=c.sources.find(s=>s.key===e.sourceKey);assert.ok(s);const start=s.content.indexOf(e.quote);assert.ok(start>=0,`${c.id}/${a.id} missing quote`);assert.equal(s.content.lastIndexOf(e.quote),start,'ambiguous quote');
  anchors.push({caseId:c.id,assertionId:a.id,sourceKey:e.sourceKey,sourceSha256:sha(s.content),start,end:start+e.quote.length,offsetUnit:'UTF-16',quote:e.quote});
 }}
 if(c.lane==='fixed_invalid')assert.ok(typeof c.candidate==='string'&&c.candidate.length>0);
}
fs.writeFileSync(path.join(dir,'anchors.json'),JSON.stringify({schema:1,anchors},null,2)+'\n');
// Local historical case inventory only; no user profile or installation backup.
const history=[],skip=new Set(['node_modules','.git','desktop','src','dist','resources','result','calls','private-install-backup-20261027']);
function scan(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){
 if(item.isSymbolicLink()||skip.has(item.name))continue;const file=path.join(folder,item.name);
 if(item.isDirectory())scan(file);
 else if(/(?:cases|suite|gold|fixtures|protocol)[-.]/.test(item.name)&&/\.(?:json|cjs)$/.test(item.name)&&fs.statSync(file).size<2000000){history.push({path:path.relative(work,file).replace(/\\/g,'/'),bytes:fs.readFileSync(file)});}
}}
for(const item of fs.readdirSync(work,{withFileTypes:true}))if(item.isDirectory()&&/^(grounding-|abcd-)/.test(item.name))scan(path.join(work,item.name));
assert.ok(history.length>0,'Historical inventory empty');
const novelty=suite.cases.map(c=>{const marker=c.title.slice(0,2),matches=history.filter(f=>f.bytes.toString('utf8').includes(marker)||f.bytes.toString('utf8').includes(c.id)).map(f=>f.path);assert.deepEqual(matches,[],c.id+' historical marker match needs review');return {caseId:c.id,marker,matches};});
fs.writeFileSync(path.join(dir,'novelty.json'),JSON.stringify({method:'exact case-id and unique business-name marker search in listed local case files; not semantic novelty proof',cases:novelty,history:history.map(f=>({path:f.path,sha256:sha(f.bytes)})).sort((a,b)=>a.path.localeCompare(b.path))},null,2)+'\n');
const deny=()=>{throw Error('OFFLINE_PREFLIGHT_FORBIDS_REAL_TRANSPORT');};
global.fetch=deny;require('node:net').Socket.prototype.connect=deny;
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])cp[k]=deny;
const {Assistant}=require(path.join(root,'desktop/core.cjs')),protocol=require(path.join(root,'desktop/subscription-protocol.cjs'));
const rows=[];
async function capture(spec,referenceDraft){
 const tmp=fs.realpathSync(os.tmpdir()),workspace=fs.realpathSync(fs.mkdtempSync(path.join(tmp,'foundation-sizing-'))),requests=[];
 let a;
 try{
  const input=project(spec);
  a=new Assistant({dir:workspace,chat:async(_p,_k,messages,options={})=>{
   assert.ok(!JSON.stringify(messages).includes(gold.canary),'gold leakage');
   const serialized=protocol.serialize(messages),schema=JSON.stringify({type:'object',properties:{response_json:{type:'string'}},required:['response_json'],additionalProperties:false});
   const row={caseId:spec.id,role:options.role,stage:options.stage,visibleBytes:Buffer.byteLength(JSON.stringify(messages)),serializedCliInputBytes:Buffer.byteLength(serialized),schemaBytes:Buffer.byteLength(schema),requestSha256:sha(serialized)};
   row.admissionReservation=row.serializedCliInputBytes+row.schemaBytes+plan.budget.reservationOutputAllowance+plan.budget.reservationFramingAllowance;
   const limit=spec.id===plan.protocolGate.id?plan.budget.protocolTokenStopThreshold:plan.caseLimits.find(c=>c.id===spec.id).tokenStopThreshold;
   assert.ok(row.admissionReservation<=limit,spec.id+' cannot admit its first request');
   assert.ok(row.visibleBytes<=plan.budget.maxVisibleRequestBytes);requests.push(row);
   options.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});
   if(options.role==='execute'&&requests.length===1)return {kind:'artifact',title:spec.title,content:referenceDraft,summary:'Synthetic preflight draft'};
   throw Object.assign(Error('Captured offline first verification input'),{code:'EVAL_OFFLINE_STOP',modelFailure:true,automaticRetry:false});
  }});
  a.data.settings.evidenceGrounding=true;a.data.settings.automatic=false;a.data.settings.autoComplete=false;
  await a.dispatch('saveProvider',{type:'codex',name:'Offline sizing only',model:plan.model.id,reasoning:plan.model.reasoning,inputPrice:0,outputPrice:0,requestPolicy:{idleMinutes:2,totalMinutes:3,retries:0}});
  a.addSources(input.sources);const task=a.createTask({title:input.title,description:input.description,criteria:input.criteria,sourceIds:a.data.sources.map(s=>s.id),generationMode:'single',steps:[{title:'形成文稿',kind:'draft'}]});
  if(spec.lane==='fixed_invalid'){
   const step=task.steps[0],artifact={id:crypto.randomUUID(),taskId:task.id,stepId:step.id,title:spec.title,content:input.candidate,origin:'user_import',createdAt:new Date().toISOString()};a.data.artifacts.push(artifact);
   require(path.join(root,'desktop/protocol-access.cjs')).retain(a,'artifact',artifact,{task});step.done=true;step.artifactId=artifact.id;require(path.join(root,'desktop/deliverables.cjs')).record(a,task,step,artifact,{});
  }
  a.save();await a.dispatch('advance',{id:task.id});await a.runPromise;
  assert.equal(requests.filter(r=>r.role==='verify').length,1,spec.id+' must reach verification capture');
  assert.equal(requests.length,spec.lane==='fixed_invalid'?1:2);rows.push(...requests);
 }finally{
  if(a){require(path.join(root,'desktop/access.cjs')).cancel(a);require(path.join(root,'desktop/deadline-scheduler.cjs')).dispose(a);}
  assert.ok(workspace.startsWith(tmp+path.sep)&&path.basename(workspace).startsWith('foundation-sizing-'));
  fs.rmSync(workspace,{recursive:true,force:true});
 }
}
(async()=>{
 await capture({...plan.protocolGate,lane:'generated'},'容澜登记袋号K-314，共7袋，仅供档案组复核，尚未向外移交。');
 for(const c of suite.cases){const g=gold.cases.find(g=>g.id===c.id);await capture(c,g.initialReferenceDraft||g.referenceDraft);}
 const output={schema:1,passed:true,liveModelCalls:0,syntheticCallbacks:rows.length,productionFilesChanged:false,asarSha256:plan.asarSha256,checkedCases:6,checkedAnchors:anchors.length,historicalFilesCompared:history.length,modelAvailabilityProbed:false,installedPackageLifecycleTested:false,liveRunnerReady:false,scope:'first generation/first verification source-level sizing only; later reads/revision inputs unknown',rows};
 fs.writeFileSync(path.join(dir,'preflight.json'),JSON.stringify(output,null,2)+'\n');
 const files=sealedFiles.map(file=>({path:file,sha256:sha(fs.readFileSync(path.join(dir,file)))})),identity=sha(JSON.stringify(files));
 fs.writeFileSync(path.join(dir,'seal.json'),JSON.stringify({schema:1,id:plan.id,files,identity,liveModelCalls:0,liveAuthorized:false},null,2)+'\n');
 console.log(JSON.stringify({passed:true,identity,liveModelCalls:0,anchors:anchors.length,history:history.length,requests:rows.length,maxVisibleBytes:Math.max(...rows.map(r=>r.visibleBytes)),maxReservation:Math.max(...rows.map(r=>r.admissionReservation))}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
