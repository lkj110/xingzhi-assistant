'use strict';
// Copied into a new system-Temp directory. The only permitted state injection is
// this one-time fixed-invalid seed, before the real packaged worker starts.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function create({Assistant,options}){
 const config=JSON.parse(fs.readFileSync(path.join(__dirname,'negative-config.json'),'utf8'));
 const tmp=fs.realpathSync(os.tmpdir()),dir=fs.realpathSync(__dirname),workspace=fs.realpathSync(options.dir);
 assert.ok(dir.startsWith(tmp+path.sep)&&workspace.startsWith(dir+path.sep));
 assert.equal(workspace,fs.realpathSync(config.workspace));
 assert.equal(sha(fs.readFileSync(__filename)),config.fixtureSha256);
 // Electron's patched fs resolves ASAR paths as a virtual directory. Read the
 // archive container through original-fs; production modules still use ASAR require.
 assert.equal(sha(require('original-fs').readFileSync(config.asar)),config.asarSha256);
 assert.equal(require(path.join(config.asar,'desktop/core.cjs')).Assistant,Assistant,'Assistant must be the installed ASAR class');
 assert.ok(!fs.existsSync(path.join(workspace,'workspace.json')),'Fixed candidate may be seeded only once');
 fs.writeFileSync(path.join(dir,'seed-started.json'),JSON.stringify({syntheticFixedDraft:true,at:new Date().toISOString()}),{flag:'wx'});
 const a=new Assistant(options),input=config.input;
 a.data.settings.evidenceGrounding=true;a.data.settings.automatic=false;a.data.settings.autoComplete=false;
 await a.dispatch('saveProvider',config.provider);
 a.addSources(input.sources);
 const task=a.createTask({title:input.title,description:input.description,criteria:input.criteria,sourceIds:a.data.sources.map(s=>s.id),generationMode:'single',steps:[{title:'形成文稿',kind:'draft'}]});
 const step=task.steps[0],artifact={id:crypto.randomUUID(),taskId:task.id,stepId:step.id,title:input.title,content:input.candidate,origin:'user_import',createdAt:new Date().toISOString()};
 a.data.artifacts.push(artifact);
 require(path.join(config.asar,'desktop/protocol-access.cjs')).retain(a,'artifact',artifact,{task});
 step.done=true;step.artifactId=artifact.id;
 require(path.join(config.asar,'desktop/deliverables.cjs')).record(a,task,step,artifact,{});
 a.save();
 const prefix=path.resolve(config.asar)+path.sep;
 const modules=Object.keys(require.cache).filter(file=>file.startsWith(prefix)).sort();
 for(const file of ['desktop/core.cjs','desktop/engine-worker.cjs','desktop/protocol-access.cjs','desktop/deliverables.cjs'])assert.ok(modules.includes(path.join(config.asar,file)),file+' was not loaded from ASAR');
 const identity={schema:1,syntheticFixedDraft:true,notUiImport:true,seededOnce:true,asar:config.asar,asarSha256:config.asarSha256,fixtureSha256:config.fixtureSha256,
  taskId:task.id,artifactId:artifact.id,candidateSha256:sha(artifact.content),sources:a.data.sources.map(s=>({id:s.id,title:s.title,sha256:sha(s.content)})),
  productionModules:modules.map(file=>path.relative(config.asar,file).replace(/\\/g,'/')),modelCallsAtSeed:a.data.modelCalls?.length||0,settings:{evidenceGrounding:true,automatic:false,autoComplete:false}};
 assert.equal(identity.modelCallsAtSeed,0);
 fs.writeFileSync(config.auditFile,JSON.stringify(identity,null,2)+'\n',{flag:'wx'});
 return a;
}
module.exports={create};
