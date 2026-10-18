'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const deny=()=>{throw Error('controlled backup fixture: real external I/O forbidden');};
require('node:child_process').spawn=deny;require('node:net').Socket.prototype.connect=deny;global.fetch=deny;
const backup=require('../desktop/recovery.cjs'),storage=require('../desktop/platform-result.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'generic-platform-backup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,data:{version:1,settings:{},tasks:[],sources:[],providers:[],artifacts:[],events:[]}};}
function archived(id){const s={operation:'code',query:{op:'code',taskId:123},data:{code:'controlled '.repeat(60000)}},split=storage.split(storage.prepare(s));return {id,title:'controlled',platformSnapshot:true,content:JSON.stringify(split.snapshot),...split.sourceMeta};}

test('create/read/restart/copy preserve every chunk; corruption cannot be recovered as an empty result',t=>{
 const a=fixture(t);a.data.sources=[archived('one'),archived('two')];
 const sizes=backup.assertStorageCapacity(a,a.data);assert.ok(sizes.workspaceBytes<backup.maxBackupBytes);
 const id=backup.create(a),file=path.join(a.dir,'backups',id),item=backup.read(a,id);
 assert.equal(fs.statSync(file).size,Buffer.byteLength(fs.readFileSync(file,'utf8')));
 assert.deepEqual(item.data,a.data);
 const restarted={dir:a.dir,data:JSON.parse(JSON.stringify(item.data))};assert.deepEqual(storage.fullSnapshot(restarted.data.sources[1]),storage.fullSnapshot(a.data.sources[1]));
 assert.equal(backup.list(restarted)[0].invalid,undefined);
 const copied=fixture(t);copied.data=structuredClone(item.data);const copyId=backup.create(copied);assert.deepEqual(backup.read(copied,copyId).data,item.data);
 item.data.sources[0].platformArchive.chunks[0].body='AAAA';item.checksum=crypto.createHash('sha256').update(JSON.stringify(item.data)).digest('hex');fs.writeFileSync(file,JSON.stringify(item));
 assert.throws(()=>backup.read(a,id),e=>e.code==='LOCAL_RESULT_INTEGRITY');assert.equal(backup.list(a)[0].invalid,true);
 a.data=item.data;const before=fs.readdirSync(path.join(a.dir,'backups'));assert.throws(()=>backup.create(a),e=>e.code==='LOCAL_RESULT_INTEGRITY');assert.deepEqual(fs.readdirSync(path.join(a.dir,'backups')),before);
});

test('candidate and create enforce 200MB UTF-8 bound, with no file or successful state mutation',t=>{
 const a=fixture(t),candidate={...a.data,payload:'界'.repeat(66_666_667)},before=JSON.stringify(a.data),start=performance.now(),rss=process.memoryUsage().rss;
 assert.throws(()=>backup.assertStorageCapacity(a,candidate),error=>error.code==='LOCAL_RESULT_STORAGE'&&error.diagnostics.workspaceBytes>200000000&&error.diagnostics.backupBytes>200000000);
 t.diagnostic(JSON.stringify({capacityCheckMs:Math.round(performance.now()-start),rssDeltaBytes:process.memoryUsage().rss-rss}));
 assert.equal(JSON.stringify(a.data),before);a.data=candidate;
 assert.throws(()=>backup.create(a),error=>error.code==='LOCAL_RESULT_STORAGE');assert.equal(a.lastBackupAt,undefined);assert.deepEqual(fs.readdirSync(a.dir),[]);
 delete candidate.payload;
});

test('backup envelope also has the same 200MB limit; read rejects an overlimit file before JSON allocation',t=>{
 const a=fixture(t);assert.throws(()=>backup.create(a,'界'.repeat(66_666_667)),error=>error.code==='LOCAL_RESULT_STORAGE'&&error.diagnostics.workspaceBytes<200000000&&error.diagnostics.backupBytes>200000000);
 assert.deepEqual(fs.readdirSync(a.dir),[]);
 fs.mkdirSync(path.join(a.dir,'backups'));const id='backup-2026T10-18-12345678.json',file=path.join(a.dir,'backups',id);fs.writeFileSync(file,'{}');fs.truncateSync(file,200000001);
 assert.throws(()=>backup.read(a,id),/过大/);
});

test('capacity cost is measured once on the full candidate, including many large archives',t=>{
 const a=fixture(t),data={operation:'code',query:{op:'code',taskId:123},data:{code:crypto.randomBytes(500000).toString('hex')}},split=storage.split(storage.prepare(data));
 a.data.sources=Array.from({length:24},(_,i)=>({id:'source-'+i,platformSnapshot:true,content:JSON.stringify(split.snapshot),...split.sourceMeta}));
 const start=performance.now(),rss=process.memoryUsage().rss,sizes=backup.assertStorageCapacity(a,a.data);
 t.diagnostic(JSON.stringify({...sizes,elapsedMs:Math.round(performance.now()-start),rssDeltaBytes:process.memoryUsage().rss-rss}));
 assert.ok(sizes.workspaceBytes>17000000);assert.ok(sizes.workspaceBytes<200000000);
});


test('capacity accounting exactly matches native JSON for Unicode, escaping, arrays and omitted fields',()=>{
 const {sizes}=require('../desktop/platform-storage-capacity.cjs');
 const values=[{},[],{a:1},[1,2,{x:[null,'abc']}],{unicode:'界🧭',lone:'\ud800x\udfff',control:'\0\b\t\r\n\f\u001f',quote:'"\\',omit:undefined,nan:NaN,yes:true,array:[undefined,Infinity,false],date:new Date('2026-10-18T00:00:00Z')},Array(3)];
 for(const data of values){const count=sizes(data);assert.equal(count.compact,Buffer.byteLength(JSON.stringify(data)));assert.equal(count.pretty,Buffer.byteLength(JSON.stringify(data,null,2)));}
});
