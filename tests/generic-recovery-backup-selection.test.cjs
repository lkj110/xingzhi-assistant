'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const deny=()=>{throw Error('controlled backup selection: external I/O forbidden');};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[name]=deny;
require('node:net').Socket.prototype.connect=deny;global.fetch=deny;
const recovery=require(path.join(root,'desktop/recovery.cjs')),storage=require(path.join(root,'desktop/platform-result.cjs'));
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'g10-backup-selection-')));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'backups'));
 const data={version:1,settings:{automatic:false},tasks:[],sources:[],providers:[],artifacts:[],events:[],delegations:[],runtime:{}};
 const a={dir,file:path.join(dir,'workspace.json'),data};fs.writeFileSync(a.file,JSON.stringify(data));return a;
}
function put(a,n,data=a.data){const at=`2026-10-${String(n).padStart(2,'0')}T00:00:00.000Z`,id=`backup-${at.replace(/[:.Z]/g,'-')}-12345678.json`;
 const text=JSON.stringify(data);fs.writeFileSync(path.join(a.dir,'backups',id),JSON.stringify({format:1,at,reason:'controlled',checksum:crypto.createHash('sha256').update(text).digest('hex'),data}));return id;}
function observe(a,read){const original=fs.readFileSync,ids=[];fs.readFileSync=function(file,...args){if(typeof file==='string'&&path.dirname(file)===path.join(a.dir,'backups'))ids.push(path.basename(file));return original.call(this,file,...args);};try{return {value:read(),ids};}finally{fs.readFileSync=original;}}
test('healthy load validates newest only; explicit list still validates every backup',t=>{
 const a=fixture(t),old=put(a,1),newest=put(a,2);
 let r=observe(a,()=>recovery.load(a,{}));assert.deepEqual(r.value,a.data);assert.deepEqual(r.ids,[newest]);
 r=observe(a,()=>recovery.list(a));assert.deepEqual(r.ids,[newest,old]);assert.equal(r.value.length,2);
});
test('checksum and archive corruption cannot masquerade as latest valid data',t=>{
 const a=fixture(t),good=put(a,1),bad=put(a,3);
 fs.writeFileSync(path.join(a.dir,'backups',bad),'{}');
 const split=storage.split(storage.prepare({operation:'code',query:{op:'code',taskId:1},data:{code:'controlled '.repeat(60000)}}));
 const data=structuredClone(a.data);data.sources.push({id:'broken',platformSnapshot:true,content:JSON.stringify(split.snapshot),...split.sourceMeta});
 data.sources[0].platformArchive.chunks[0].body='AAAA';const archive=put(a,2,data);
 const r=observe(a,()=>recovery.load(a,{}));assert.deepEqual(r.ids,[bad,archive,good]);assert.deepEqual(r.value,a.data);
 assert.equal(a.lastBackupAt,Date.parse('2026-10-01T00:00:00.000Z'));
});
test('damaged workspace revalidates selected backup before authority reconciliation',t=>{
 const a=fixture(t),good=put(a,1),bad=put(a,2);fs.writeFileSync(path.join(a.dir,'backups',bad),'{}');fs.writeFileSync(a.file,'damaged');
 const r=observe(a,()=>recovery.load(a,{}));assert.deepEqual(r.ids,[bad,good,good]);assert.equal(r.value.runtime.recoveredBackup,good);assert.equal(r.value.settings.automatic,false);assert.equal(a.recoveryFromBackup,true);
 assert.ok(fs.readdirSync(a.dir).some(n=>n.startsWith('workspace-damaged-')));
});
test('no valid backup does not turn a damaged workspace into empty success; errors are retried fresh',t=>{
 const a=fixture(t),id=put(a,1),file=path.join(a.dir,'backups',id),valid=fs.readFileSync(file);
 fs.writeFileSync(file,'{}');fs.writeFileSync(a.file,'damaged');assert.throws(()=>recovery.load(a,{}),/没有有效备份/);assert.equal(fs.readFileSync(a.file,'utf8'),'damaged');
 fs.writeFileSync(file,valid);const r=observe(a,()=>recovery.load(a,{}));assert.deepEqual(r.ids,[id,id]);assert.equal(r.value.runtime.recoveredBackup,id);
});
test('healthy workspace remains usable with invalid backup, missing workspace stays fresh only with none valid',t=>{
 const a=fixture(t),id=put(a,1);fs.writeFileSync(path.join(a.dir,'backups',id),'{}');assert.deepEqual(recovery.load(a,{}),a.data);
 fs.unlinkSync(a.file);const initial={marker:'initial'};assert.equal(recovery.load(a,initial),initial);
});
test('a selected backup changed between selection and restore is rejected by real validation',t=>{
 const a=fixture(t),id=put(a,1),file=path.join(a.dir,'backups',id);fs.writeFileSync(a.file,'damaged');
 const original=fs.readFileSync;let count=0;fs.readFileSync=function(p,...args){if(p===file&&++count===2)fs.writeFileSync(file,'{}');return original.call(this,p,...args);};
 try{assert.throws(()=>recovery.load(a,{}),/备份校验失败/);assert.equal(count,2);assert.equal(a.recoveryFromBackup,undefined);}finally{fs.readFileSync=original;}
});
