'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {stringBytes,CHUNK_UNITS}=require('../desktop/json-string-bytes.cjs');
const exact=s=>Buffer.byteLength(JSON.stringify(s));
test('bounded native JSON byte count preserves every UTF-16 code unit and JSON escape',()=>{
  const controls=Array.from({length:0x10000},(_,i)=>String.fromCharCode(i)).join('');
  for(const text of ['',controls,controls.repeat(3),'中文😀é\u2028\u2029','"\\\n\r\t\b\f\u0000'.repeat(40000),
    'x'.repeat(CHUNK_UNITS-1)+'😀','x'.repeat(CHUNK_UNITS-1)+'\ud800x\udc00',
    '\ud800'.repeat(CHUNK_UNITS)+'\udc00'.repeat(CHUNK_UNITS), '😀'.repeat(CHUNK_UNITS)])assert.equal(stringBytes(text),exact(text));
  // Deterministic arbitrary code units include valid pairs and lone surrogates.
  let seed=1;
  for(let trial=0;trial<50;trial++){
    let value='';for(let i=0;i<2000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;value+=String.fromCharCode(seed&65535);}
    assert.equal(stringBytes(value),exact(value));
  }
});
test('JSON escaping allocation is bounded independently of source/workspace size',t=>{
  const original=JSON.stringify,seen=[];
  t.mock.method(JSON,'stringify',value=>{seen.push(value.length);assert.ok(value.length<=CHUNK_UNITS+1);return original(value);});
  const text='"\\\n😀'.repeat(200000);
  assert.equal(stringBytes(text),Buffer.byteLength(original(text)));
  assert.ok(seen.length>1);
});
test('invalid input and escaping errors are propagated, never cached or converted to zero',t=>{
  for(const input of [null,undefined,1,{},new String('x')])assert.throws(()=>stringBytes(input),TypeError);
  const original=JSON.stringify;let failed=true;
  t.mock.method(JSON,'stringify',s=>{if(failed)throw Error('controlled failure');return original(s);});
  assert.throws(()=>stringBytes('a'),/controlled failure/);failed=false;assert.equal(stringBytes('a'),3);
});
