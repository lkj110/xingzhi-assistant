'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {root,pack,candidatePack,noticeAcceptancePack,selectPack}=require('./common.cjs');
test('three fixed profiles preserve installed, exposed offline and fresh candidate identities',()=>{
 assert.deepEqual(selectPack(),{pack,candidate:false});
 assert.deepEqual(selectPack({candidate:true}),{pack:candidatePack,candidate:true});
 assert.deepEqual(selectPack({noticeAcceptance:true}),{pack:noticeAcceptancePack,candidate:true});
 assert.equal(candidatePack,path.join(root,'evaluations/foundation-notice-regression-20261028'));
 assert.equal(noticeAcceptancePack,path.join(root,'evaluations/foundation-notice-acceptance-20261028'));
 assert.equal(new Set([pack,candidatePack,noticeAcceptancePack]).size,3);
});
test('ambiguous or non-boolean profile requests are rejected',()=>{
 assert.throws(()=>selectPack({candidate:true,noticeAcceptance:true}),/only one/);
 for(const key of ['candidate','noticeAcceptance'])for(const value of [null,1,'true','../arbitrary'])assert.throws(()=>selectPack({[key]:value}));
});

test('run entry rejects mixed profiles before touching output or credentials',{skip:process.platform!=='win32'},async()=>{
 const fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');
 const {run}=require('./run.cjs'),output=path.join(os.tmpdir(),'foundation-profile-reject-'+crypto.randomUUID());
 await assert.rejects(run({executable:path.join(output,'not-a-real-executable.exe'),output,mode:'live',candidate:true,noticeAcceptance:true}),/only one fixed candidate profile/);
 assert.equal(fs.existsSync(output),false);
});
