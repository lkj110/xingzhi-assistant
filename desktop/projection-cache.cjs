'use strict';
// Pure, synchronous reads only. Object identity is valid for this immutable
// call stack, never for a later inspect, commit, admission or dispatch.
let active=null,epoch=0;
function run(read){return active?.pure?read():enter(read,false);}
function scope(read){return active?.pure?read():enter(read,true);}
function fresh(read){return enter(read,true);}
function enter(read,pure){
 const previous=active;active={map:new Map(),pure,epoch};
 try{return read();}finally{active=previous;}
}
// A mutation/admission boundary must discard even an enclosing pure scope.
function without(read){
 const previous=active;epoch++;previous?.map.clear();active=null;
 try{return read();}finally{active=previous;}
}
function memo(namespace,keys,read){
 if(!active)return read();
 if(active.epoch!==epoch){active.map.clear();active.epoch=epoch;}
 let entry=active.map;
 for(const key of [namespace,...keys]){if(!entry.has(key))entry.set(key,new Map());entry=entry.get(key);}
 if(entry.has(memo))return entry.get(memo);
 const value=read();
 // The synchronous finally above releases the scope before any continuation.
 if(!value||typeof value.then!=='function')entry.set(memo,value);
 return value;
}
// Public projections get their own mutable copy on BOTH the miss and hit.
// memo itself is for private values (or existing identity-valued helpers).
function copy(namespace,keys,read){return structuredClone(memo(namespace,keys,read));}
module.exports={run,scope,fresh,without,memo,copy};
