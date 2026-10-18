'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');

for(const mode of ['passed','failed','thrown'])test(`G10 CLI redirected ${mode}: restores output without exempting descriptors from isolation`,t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'g10-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const out=path.join(root,'stdout'),err=path.join(root,'stderr');
 const fds=[fs.openSync(out,'w'),fs.openSync(err,'w')];
 const script=`
 const fs=require('node:fs'),path=require('node:path');let assert;
 const probe=require(${JSON.stringify(path.resolve(__dirname,'./helpers/recovery-performance-contract.cjs'))});
 if(process.moduleLoadList.includes('NativeModule internal/fs/sync_write_stream'))throw Error('stdout initialized before isolation');
 const audit=probe.zero(),guard=probe.installIsolation(${JSON.stringify(root)},audit);
 // Reproduce Node's lazy SyncWriteStream initialization while writeSync is patched.
 void process.stdout;void process.stderr;assert=require('node:assert/strict');
 try{
   assert.throws(()=>fs.writeSync(1,'forbidden'),/OUTSIDE_COPY/);
   assert.throws(()=>fs.writeSync(2,'forbidden'),/OUTSIDE_COPY/);
   assert.throws(()=>fs.writeFileSync(path.join(${JSON.stringify(root)},'..','forbidden'),'no'),/OUTSIDE_COPY/);
 }finally{guard.restore();}
 assert.equal(audit.outsideWriteAttempts,3);
 probe.runCli([],async()=>{
   if(${JSON.stringify(mode)}==='thrown')throw Object.assign(Error('fixture error'),{code:'FIXTURE_FAILURE'});
   return {status:${JSON.stringify(mode)},correctnessPassed:true,performancePassed:${mode==='passed'},output:'fixture',assertions:[],performanceGates:[],samples:[]};
 }).then(code=>{process.exitCode=code;});`;
 let result;try{result=spawnSync(process.execPath,['-e',script],{stdio:['ignore',...fds],timeout:30000});}finally{fds.forEach(fd=>fs.closeSync(fd));}
 assert.ifError(result.error);assert.equal(result.signal,null);
 const stdout=fs.readFileSync(out,'utf8'),stderr=fs.readFileSync(err,'utf8');
 assert.equal(result.status,mode==='passed'?0:1,stderr);
 if(mode==='thrown'){assert.equal(stdout,'');assert.equal(JSON.parse(stderr).code,'FIXTURE_FAILURE');}
 else{assert.equal(stderr,'');assert.equal(JSON.parse(stdout).status,mode);}
});
