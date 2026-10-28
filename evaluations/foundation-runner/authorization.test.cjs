'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const {claimAuthorization}=require('./authorization.cjs');
const runnerIdentity='a'.repeat(64),sealIdentity='b'.repeat(64);
function setup(t){
 const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'foundation-authorization-test-'));t.after(()=>{assert.ok(fs.realpathSync(dir).startsWith(base+path.sep)&&path.basename(dir).startsWith('foundation-authorization-test-'));fs.rmSync(dir,{recursive:true,force:true});});
 const output=path.join(dir,'new-output'),authorizationPath=path.join(dir,'synthetic-approval.json'),authorization={schema:1,grantedBy:'user',reference:'SYNTHETIC_OFFLINE_TEST_ONLY',runId:crypto.randomUUID(),outputDirectory:output,runnerIdentity,sealIdentity};
 fs.writeFileSync(authorizationPath,JSON.stringify(authorization,null,2)+'\n');return {dir,output,authorizationPath,authorization,runnerIdentity,sealIdentity};
}
test('exact matching approval is consumed once and records its raw-file hash',t=>{
 const args=setup(t),result=claimAuthorization(args),bytes=fs.readFileSync(args.authorizationPath);
 assert.equal(result.authorizationSha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(result.runId,args.authorization.runId);assert.equal(result.outputDirectory,args.output);assert.equal(fs.existsSync(args.output),false);assert.equal(result.consumedPath,args.authorizationPath+'.consumed.json');
 assert.equal(JSON.parse(fs.readFileSync(result.consumedPath,'utf8')).authorizationSha256,result.authorizationSha256);
 assert.throws(()=>claimAuthorization(args),{code:'AUTH_CONSUMED'});
});
test('same approval cannot authorize another output or a mismatched runner/sample',t=>{
 const args=setup(t);assert.throws(()=>claimAuthorization({...args,output:path.join(args.dir,'another-output')}),{code:'AUTH_OUTPUT'});assert.throws(()=>claimAuthorization({...args,runnerIdentity:'c'.repeat(64)}),{code:'AUTH_IDENTITY'});assert.throws(()=>claimAuthorization({...args,sealIdentity:'c'.repeat(64)}),{code:'AUTH_IDENTITY'});assert.equal(fs.existsSync(args.authorizationPath+'.consumed.json'),false);
});
test('an altered in-memory approval cannot borrow an unchanged file',t=>{
 const args=setup(t);assert.throws(()=>claimAuthorization({...args,authorization:{...args.authorization,reference:'forged-reference'}}),{code:'AUTH_CONTENT'});assert.throws(()=>claimAuthorization({...args,authorization:{...args.authorization,runId:crypto.randomUUID()}}),{code:'AUTH_CONTENT'});assert.equal(fs.existsSync(args.authorizationPath+'.consumed.json'),false);
});
test('explicit user provenance, UUID and absolute matching output are mandatory',t=>{
 const args=setup(t);for(const patch of [{grantedBy:'runner'},{reference:''},{reference:'  '}])assert.throws(()=>claimAuthorization({...args,authorization:{...args.authorization,...patch}}),{code:'AUTH_USER'});
 for(const runId of ['',null,'not-a-uuid','00000000-0000-0000-0000-000000000000'])assert.throws(()=>claimAuthorization({...args,authorization:{...args.authorization,runId}}),{code:'AUTH_RUN_ID'});
 assert.throws(()=>claimAuthorization({...args,output:'relative-output'}),{code:'AUTH_OUTPUT'});assert.throws(()=>claimAuthorization({...args,authorization:{...args.authorization,outputDirectory:'relative-output'}}),{code:'AUTH_OUTPUT'});assert.throws(()=>claimAuthorization({...args,authorizationPath:'relative.json'}),{code:'AUTH_FILE'});
});
test('multiple missing output ancestors are canonicalized without creating them',t=>{
 const args=setup(t);args.output=path.join(args.dir,'nested','future','output');args.authorization.outputDirectory=args.output;fs.writeFileSync(args.authorizationPath,JSON.stringify(args.authorization));const result=claimAuthorization(args);assert.equal(result.outputDirectory,args.output);assert.equal(fs.existsSync(path.join(args.dir,'nested')),false);
});
test('unreadable, malformed and non-file approvals cannot be consumed',t=>{
 const args=setup(t);assert.throws(()=>claimAuthorization({...args,authorizationPath:path.join(args.dir,'missing.json')}),{code:'AUTH_FILE'});assert.throws(()=>claimAuthorization({...args,authorizationPath:args.dir}),{code:'AUTH_FILE'});fs.writeFileSync(args.authorizationPath,'{incomplete');assert.throws(()=>claimAuthorization(args),{code:'AUTH_FILE'});assert.equal(fs.existsSync(args.authorizationPath+'.consumed.json'),false);
});
test('exclusive claim permits exactly one competing local process',async t=>{
 const args=setup(t),modulePath=path.join(__dirname,'authorization.cjs');
 const script="const fs=require('node:fs');const {claimAuthorization}=require(process.argv[1]);const file=process.argv[2],a=JSON.parse(fs.readFileSync(file,'utf8'));try{const r=claimAuthorization({authorizationPath:file,authorization:a,output:a.outputDirectory,runnerIdentity:a.runnerIdentity,sealIdentity:a.sealIdentity});process.stdout.write(JSON.stringify({ok:true,runId:r.runId}));}catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code}));}";
 const results=await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const child=cp.spawn(process.execPath,['-e',script,modulePath,args.authorizationPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(e){reject(e);}});})));assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.code==='AUTH_CONSUMED').length,3);
});
test('fsync failure refuses execution and leaves a non-reusable marker',t=>{
 const args=setup(t),original=fs.fsyncSync;fs.fsyncSync=()=>{throw Object.assign(Error('synthetic storage failure'),{code:'EIO'});};
 try{assert.throws(()=>claimAuthorization(args),{code:'AUTH_PERSIST'});}finally{fs.fsyncSync=original;}
 assert.ok(fs.existsSync(args.authorizationPath+'.consumed.json'));assert.throws(()=>claimAuthorization(args),{code:'AUTH_CONSUMED'});
});
test('write failure also leaves the exclusive claim closed',t=>{
 const args=setup(t),original=fs.writeFileSync;fs.writeFileSync=(file,...rest)=>{if(typeof file==='number')throw Object.assign(Error('synthetic disk-full'),{code:'ENOSPC'});return original(file,...rest);};
 try{assert.throws(()=>claimAuthorization(args),{code:'AUTH_PERSIST'});}finally{fs.writeFileSync=original;}
 assert.ok(fs.existsSync(args.authorizationPath+'.consumed.json'));assert.throws(()=>claimAuthorization(args),{code:'AUTH_CONSUMED'});
});
test('output that is a regular file is rejected before any claim',t=>{const args=setup(t);fs.writeFileSync(args.output,'not a directory');assert.throws(()=>claimAuthorization(args),{code:'AUTH_OUTPUT'});assert.equal(fs.existsSync(args.authorizationPath+'.consumed.json'),false);});
