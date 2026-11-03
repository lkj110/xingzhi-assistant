'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyArchiveDelta,PATCH}=require('../scripts/prepare-notification-candidate.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(){
 const entry=text=>({bytes:Buffer.from(text),sha256:sha(text),unpacked:false});
 const before={directories:[],files:new Map([...PATCH.map(p=>[p,entry('old '+p)]),['desktop/grounding.cjs',entry('frozen business logic')],['dist/index.html',entry('frozen UI')],['desktop/main.cjs',entry('frozen lifecycle')]])};
 const inputs=PATCH.map(p=>({path:p,bytes:Buffer.from('reviewed '+p)}));
 const after={directories:[],files:new Map(before.files)};for(const f of inputs)after.files.set(f.path,entry(f.bytes));
 return {before,after,inputs};
}
test('notification overlay accepts exactly the two reviewed shell/bridge changes',()=>{
 const {before,after,inputs}=fixture();assert.deepEqual(verifyArchiveDelta(before,after,inputs).map(f=>f.path).sort(),PATCH);
});
for(const p of ['desktop/grounding.cjs','dist/index.html','desktop/main.cjs'])test('rejects an unrelated package change: '+p,()=>{
 const {before,after,inputs}=fixture();after.files.set(p,{...after.files.get(p),sha256:sha('drift')});assert.throws(()=>verifyArchiveDelta(before,after,inputs));
});
test('rejects missing or added entries and unpacked flag changes',()=>{
 for(const mutate of [a=>a.files.delete('dist/index.html'),a=>a.files.set('extra.cjs',{sha256:'x'}),a=>a.files.set(PATCH[0],{...a.files.get(PATCH[0]),unpacked:true}),a=>a.directories.push({path:'extra',type:'directory'})]){
  const {before,after,inputs}=fixture();mutate(after);assert.throws(()=>verifyArchiveDelta(before,after,inputs));
 }
});
test('rejects missing, duplicate or unchanged patch inputs',()=>{
 for(const mutate of [f=>f.inputs.pop(),f=>f.inputs.push(f.inputs[0]),f=>f.after.files.set(PATCH[0],f.before.files.get(PATCH[0]))]){
  const f=fixture();mutate(f);assert.throws(()=>verifyArchiveDelta(f.before,f.after,f.inputs));
 }
});
