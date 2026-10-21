'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const ROOT=path.resolve(__dirname,'../..');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const history=require('./offline-test-support.cjs');
const audit=()=>({networkAttempts:0,modelAttempts:0,subprocessAttempts:0,outsideWriteAttempts:0});
const zero=value=>assert.deepEqual(value,audit());
function memoryStorage() {
  const root = path.resolve(require('node:os').tmpdir(),'__consumption_performance_memory__').replace(/\\/g,'/'), entries = new Map(), fds = new Map(), undo = [];
  let seq = 1, nextFd = 1000000;
  const inside = f => typeof f !== 'number' && String(f).replace(/\\/g,'/').startsWith(root + '/');
  const key = f => typeof f === 'number' ? fds.get(f) : path.resolve(String(f)).replace(/\\/g,'/');
  const err = (code, f) => Object.assign(Error(code + ': ' + f), {code});
  const set = (f, data, directory=false) => entries.set(key(f), {data:Buffer.from(data),directory,seq:seq++});
  const get = f => {const v=entries.get(key(f));if(!v)throw err('ENOENT',f);return v;};
  const patch = (name, fn) => {const old=fs[name];fs[name]=(...args)=>fn(old,...args);undo.push(()=>{fs[name]=old;});};
  const mapped = f => fds.has(f)||inside(f);
  patch('mkdtempSync', (old, prefix) => {
    if(!String(prefix).includes('root-relation-contract-'))throw err('UNEXPECTED_TEMP_PATH',prefix);
    const dir=root+'/'+crypto.randomUUID();set(dir,'',true);return dir;
  });
  patch('existsSync',(old,f)=>mapped(f)?entries.has(key(f)):old(f));
  patch('mkdirSync',(old,f,o)=>{if(!mapped(f))return old(f,o);set(f,'',true);});
  patch('readFileSync',(old,f,o)=>{if(!mapped(f))return old(f,o);const b=Buffer.from(get(f).data);return typeof o==='string'||o?.encoding?b.toString(typeof o==='string'?o:o.encoding):b;});
  patch('writeFileSync',(old,f,b,o)=>{if(!mapped(f))return old(f,b,o);set(f,b);});
  patch('appendFileSync',(old,f,b,o)=>{if(!mapped(f))return old(f,b,o);set(f,Buffer.concat([entries.get(key(f))?.data||Buffer.alloc(0),Buffer.from(b)]));});
  patch('openSync',(old,f,flags,...args)=>{
    if(!mapped(f))return old(f,flags,...args);
    if(String(flags).includes('x')&&entries.has(key(f)))throw err('EEXIST',f);
    if(/[wa]/.test(flags))set(f,'');else get(f);
    const fd=nextFd++;fds.set(fd,key(f));return fd;
  });
  patch('closeSync',(old,fd)=>fds.has(fd)?fds.delete(fd):old(fd));
  patch('fsyncSync',(old,fd)=>fds.has(fd)?undefined:old(fd));
  patch('renameSync',(old,from,to)=>{if(!mapped(from)&&!mapped(to))return old(from,to);assert.ok(mapped(from)&&mapped(to));const v=get(from);entries.set(key(to),{...v,seq:seq++});entries.delete(key(from));});
  patch('copyFileSync',(old,from,to)=>{if(!mapped(to))return old(from,to);set(to,fs.readFileSync(from));});
  patch('unlinkSync',(old,f)=>{if(!mapped(f))return old(f);get(f);entries.delete(key(f));});
  patch('rmSync',(old,f,o)=>{if(!mapped(f))return old(f,o);for(const k of entries.keys())if(k===key(f)||k.startsWith(key(f)+'/'))entries.delete(k);});
  patch('readdirSync',(old,f,o)=>{if(!mapped(f))return old(f,o);get(f);return [...new Set([...entries.keys()].filter(k=>k.startsWith(key(f)+'/')).map(k=>k.slice(key(f).length+1).split('/')[0]))].sort();});
  for(const method of ['statSync','lstatSync'])patch(method,(old,f,o)=>{
    if(!mapped(f))return old(f,o);const v=get(f),num=x=>o?.bigint?BigInt(x):x;
    return {size:num(v.data.length),dev:num(1),ino:num(v.seq),mode:num(v.directory?0o40700:0o100600),mtimeNs:num(v.seq),ctimeNs:num(v.seq),mtimeMs:v.seq,ctimeMs:v.seq,
      isFile:()=>!v.directory,isDirectory:()=>v.directory,isSymbolicLink:()=>false};
  });
  patch('accessSync',(old,f,m)=>mapped(f)?void get(f):old(f,m));
  const transport=audit(), guard=history.installIsolation(root,transport);
  return {root,transport,restore(){guard.restore();for(const f of undo.reverse())f();zero(transport);}};
}

function oldCurrentWithActiveDependencies() {
  // Run the exact r7 current implementation, resolving its dependencies to the
  // active source tree. This is an independent some-per-target semantic oracle.
  const Module=require('node:module'), filename=path.join(ROOT,'desktop/evidence-consumption.cjs');
  const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));
  const source=fs.readFileSync(path.join(ROOT,'tests/fixtures/consumption-r7.cjs'),'utf8');
  assert.equal(sha(source),'2d6ca03b8aebea77197e41877a75351a07f7a28485e689078df9a6b4c79deea6','frozen r7 oracle changed');
  mod._compile(source,filename);
  return mod.exports;
}

function scaleFixture(t, targets, proofs) {
  const memory=memoryStorage();
  const {fixture}=require('../root-relation-fixture.cjs');
  const f=fixture(t,{roots:Array.from({length:targets},(_,i)=>String(123+i)),kinds:'物理表血缘'});
  t.after(()=>memory.restore());
  const {a,job,task}=f, store=require('../../desktop/access-policy-store.cjs');
  job.platformPrincipal='consumption-scale';
  store.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'fixture'});
  const artifact={id:'scale-original',taskId:task.id,stepId:task.steps[0].id,title:'交接',content:'# 交接\n\n## 输入\n已有事实。',createdAt:new Date().toISOString()};
  a.data.artifacts.push(artifact);require('../../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});task.primaryArtifactId=artifact.id;task.steps[0].artifactId=artifact.id;task.generationMode='single';
  require('../../desktop/continuation-control.cjs').redirect(a,job,{args:{taskId:task.id}},{code:'PLAN_ALREADY_RECONCILED',message:'同一计划已协调',taskId:task.id});
  for(let i=0;i<targets;i++)f.source('outputs',{outputs:[{database:'db',table:'out'}]},{taskId:123+i});
  const relation=require('../../desktop/relation-obligations.cjs'), o=relation.required(a,job,task)[0];
  const anchor=relation.requestProof(a,job,task,{requirements:[o.id]});
  const center=f.source('table_lineage',require('../root-relation-physical-fixture.cjs').data('out'),{database:'db',table:'out'});
  const request={kind:'needs_evidence',basis:'scale-proof',recoveryRequest:anchor};
  const proof=relation.resolutionProof(a,job,task,task,request,[center.id]);assert.ok(proof.facts.length>=targets);
  const resolution={basis:request.basis,recoveryProof:proof,sourceIds:[center.id]};
  const events=Array.from({length:proofs},()=>({type:'evidence_plan_committed',entityId:task.id,workRevision:task.workRevision??1,payload:{task:{set:{lastEvidenceResolution:structuredClone(resolution)}}}}));
  const journal=require('../../desktop/work-journal.cjs');let visited=[];
  events.forEach((e,i)=>{let value=e.payload.task.set.lastEvidenceResolution;Object.defineProperty(e.payload.task.set,'lastEvidenceResolution',{enumerable:true,get(){visited.push(i);return value;},set(v){value=v;}});});
  t.mock.method(journal,'read',()=>({events}));
  const c=require('../../desktop/evidence-consumption.cjs'), inspection=c.inspect(a,job,task);
  assert.equal(inspection?.phase,'prepare_pending',JSON.stringify(inspection));
  const p=inspection.proof;p.targetFacts=p.targetFacts.slice(0,targets);p.additionalFacts=[];assert.equal(p.targetFacts.length,targets);
  return {...f,center,artifact,p,events,memory,visits:()=>visited,resetVisits:()=>{visited=[];}};
}

function profile(runtime) {
  const undo=[], totals={projects:0,projectMs:0,hashCalls:0,hashMs:0,aclCalls:0,aclMs:0};
  function wrap(object,key,count,time){const old=object[key];object[key]=function(...args){const start=performance.now();totals[count]++;try{return old.apply(this,args);}finally{totals[time]+=performance.now()-start;}};undo.push(()=>{object[key]=old;});}
  // Install hash wrapper before dependent modules capture the hash export.
  wrap(require(path.join(runtime,'desktop/evidence-basis.cjs')),'hash','hashCalls','hashMs');
  wrap(require(path.join(runtime,'desktop/physical-lineage-coverage.cjs')),'project','projects','projectMs');
  wrap(require(path.join(runtime,'desktop/access-policy-store.cjs')),'check','aclCalls','aclMs');
  return {totals,measure(fn){const before={...totals},start=performance.now();const value=fn();return {value,ms:performance.now()-start,...Object.fromEntries(Object.keys(totals).map(k=>[k,totals[k]-before[k]]))};},restore(){for(const f of undo.reverse())f();}};
}
module.exports={ROOT,memoryStorage,scaleFixture,oldCurrentWithActiveDependencies,profile,zero};
