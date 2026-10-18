'use strict';
// Exact byte counts for the two JSON representations persisted by the app.
// Counting does not allocate a workspace-sized escaped/indented JSON string.
const {stringBytes}=require('./json-string-bytes.cjs');
function sizes(value){
 const ancestors=new Set();
 function walk(v,depth,key){
  if(v&&typeof v.toJSON==='function')v=v.toJSON(key);
  if(v instanceof Number||v instanceof Boolean||v instanceof String)v=v.valueOf();
  if(v===null)return {compact:4,pretty:4};
  if(typeof v==='string'){const n=stringBytes(v);return {compact:n,pretty:n};}
  if(typeof v==='number'||typeof v==='boolean'){const n=Buffer.byteLength(JSON.stringify(v));return {compact:n,pretty:n};}
  if(typeof v==='bigint')throw new TypeError('BigInt cannot be serialized');
  if(typeof v!=='object')return null;
  if(ancestors.has(v))throw new TypeError('Circular workspace');
  ancestors.add(v);
  try{
   const array=Array.isArray(v);let compact=2,pretty=2,count=0;
   for(const key of array?Array.from({length:v.length},(_,i)=>String(i)):Object.keys(v)){
    let child=walk(v[key],depth+1,key);if(!child){if(!array)continue;child={compact:4,pretty:4};}
    const label=array?0:stringBytes(key)+1;
    compact+=child.compact+label;
    pretty+=child.pretty+label+(array?0:1)+2*(depth+1);
    count++;
   }
   if(count){compact+=count-1;pretty+=count-1+count+1+depth*2;}
   return {compact,pretty};
  }finally{ancestors.delete(v);}
 }
 return walk(value,0,'');
}
module.exports={sizes};
