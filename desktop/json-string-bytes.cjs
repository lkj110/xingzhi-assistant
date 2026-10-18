'use strict';
// Exact UTF-8 size of JSON.stringify(string). Native escaping avoids a JS
// match iterator per quote/control character. Bounded chunks avoid allocating
// a workspace-sized escaped string; no value or error is cached.
const CHUNK_UNITS=65536;
function stringBytes(value){
  if(typeof value!=='string')throw new TypeError('JSON string byte count requires a string');
  if(value.length<=CHUNK_UNITS)return Buffer.byteLength(JSON.stringify(value));
  let bytes=2;
  for(let start=0;start<value.length;){
    let end=Math.min(start+CHUNK_UNITS,value.length);
    // JSON.stringify preserves valid pairs but escapes each lone surrogate.
    // A split must not turn one four-byte scalar into two escaped units.
    if(end<value.length){const high=value.charCodeAt(end-1),low=value.charCodeAt(end);if(high>=0xd800&&high<=0xdbff&&low>=0xdc00&&low<=0xdfff)end++;}
    bytes+=Buffer.byteLength(JSON.stringify(value.slice(start,end)))-2;
    start=end;
  }
  return bytes;
}
module.exports={stringBytes,CHUNK_UNITS};
