'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const cache=require('../desktop/projection-cache.cjs'),links=require('../desktop/evidence-links.cjs'),store=require('../desktop/evidence-store.cjs');
test('explicit pure scope shares nested pure and legacy reads, releases on return/error/await',async()=>{
 const ns={},key={};let reads=0;
 const value=()=>cache.memo(ns,[key],()=>++reads);
 cache.scope(()=>{assert.equal(value(),1);cache.scope(()=>assert.equal(value(),1));cache.run(()=>assert.equal(value(),1));});
 assert.equal(value(),2);
 assert.throws(()=>cache.scope(()=>{assert.equal(value(),3);throw Error('failed');}),/failed/);
 assert.equal(value(),4);
 await cache.scope(async()=>{assert.equal(value(),5);await Promise.resolve();assert.equal(value(),6);});
 assert.equal(value(),7);
 cache.scope(()=>{assert.equal(value(),8);cache.without(()=>assert.equal(value(),9));assert.equal(value(),10);});
 let pending=0;cache.scope(()=>{for(let n=0;n<2;n++)cache.memo(ns,[key],()=>{pending++;return Promise.resolve();});});assert.equal(pending,2);
});
test('copy protects miss and hit values; distinct exact keys and new scopes recompute',()=>{
 let reads=0;const ns={},key={};
 const read=k=>cache.copy(ns,[k],()=>{reads++;return {frontier:[{roots:['123']}]};});
 cache.scope(()=>{const one=read(key);one.frontier[0].roots.push('tampered');assert.deepEqual(read(key),{frontier:[{roots:['123']}]});read({});assert.equal(reads,2);});
 read(key);assert.equal(reads,3);
});
test('batched source ancestry has the same ambiguous, cycle, copy, identity and scope semantics',()=>{
 const base={id:'a',identity:'same',projectId:'p'},b={...base,id:'b',previousSourceId:'a'},c={...base,id:'c',previousSourceId:'b'};
 const scenarios=[[base],[base,b,c],[base,b,{...c,previousSourceId:'a'}],[{...base,previousSourceId:'b'},b],
  [base,{...b,copiedFrom:'x'}],[base,{...b,projectExcluded:true},c],[base,{...b,deleted:true},c],
  [base,{...b,projectId:'q'},c],[base,{...b,identity:'other'},c],[base,{...b,previousSourceId:'absent'}],
  [base,b,{...b,projectId:'other'},c],[base,{...base,identity:'other'},b],
  [{id:'a'},{id:'b',previousSourceId:'a'},{id:'c',previousSourceId:'b',resourceKey:'resource'}]];
 for(const sources of scenarios){const data={sources},before=JSON.stringify(data),expected=sources.map(s=>store.current(data,s));cache.scope(()=>sources.forEach((s,i)=>assert.equal(links.currentSourceId(data,s),expected[i]?.id??null,JSON.stringify(sources))));assert.equal(JSON.stringify(data),before);}
});
test('exact content digest is reused without trusting fullContentHash or revision metadata',t=>{
 const crypto=require('node:crypto'),create=crypto.createHash;let calls=0;t.mock.method(crypto,'createHash',(...args)=>{calls++;return create(...args);});
 const source={content:'body',fullContentHash:'untrusted'};
 cache.scope(()=>{assert.equal(links.revision(source),links.contentHash(source));assert.equal(calls,1);source.content='changed';assert.notEqual(links.revision(source),links.contentHash({content:'body'}));assert.equal(calls,2);});
 links.revision(source);assert.equal(calls,3);
});
test('a mutation boundary also invalidates a suspended enclosing fresh scope',()=>{
 let calls=0;const read=()=>cache.memo('boundary',[],()=>++calls);
 cache.scope(()=>{assert.equal(read(),1);cache.fresh(()=>{assert.equal(read(),2);cache.without(()=>{});});assert.equal(read(),3);});
});
