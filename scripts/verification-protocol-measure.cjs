'use strict';
// Run only synthetic transports, with the same new fixture in both checkouts.
// Usage: node scripts/verification-protocol-measure.cjs BASELINE OUTPUT.json
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {run}=require('../tests/helpers/verification-stage-fixture.cjs');
const baseline=path.resolve(process.argv[2]),candidate=path.resolve(__dirname,'..'),output=path.resolve(process.argv[3]);
process.env.NODE_PATH=[path.join(candidate,'node_modules'),process.env.NODE_PATH].filter(Boolean).join(path.delimiter);require('node:module').Module._initPaths();
global.fetch=()=>{throw Error('Real network/model forbidden in offline measurement');};
function bodies(payload){const values=[];const walk=value=>{if(!value||typeof value!=='object')return;for(const [k,v] of Object.entries(value)){if(['text','content','originalContent','resultText','quote'].includes(k)&&typeof v==='string')values.push([k,v]);else walk(v);}};walk(payload);return [...new Map(values.map(v=>[JSON.stringify(v),v])).values()].sort();}
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function main(){
 const rows=[];
 for(const phase of ['content','result'])for(const variant of [{name:'read',mode:'read'},{name:'incremental',mode:'read',incremental:true},{name:'read-basic',mode:'read',search:false,compute:false},{name:'final',mode:'final'},{name:'classification',mode:'classification'}]){
  const pair={};
  for(const [arm,root] of [['baseline',baseline],['candidate',candidate]]){
   const result=await run(root,{phase,...variant}),call=result.calls.at(-1);
   pair[arm]={schemaBytes:call.schema.utf8Bytes,fullInputBytes:call.bytes,messageBytes:call.bytes-call.schema.utf8Bytes,contract:call.contract,bodyHash:hash(bodies(call.payload)),syntheticCalls:result.calls.length};
  }
  if(pair.baseline.bodyHash!==pair.candidate.bodyHash)throw Error('Evidence/draft body mismatch: '+phase+'/'+variant.name);
  const reduction={};for(const key of ['schemaBytes','fullInputBytes','messageBytes'])reduction[key]={bytes:pair.baseline[key]-pair.candidate[key],percent:+((1-pair.candidate[key]/pair.baseline[key])*100).toFixed(2)};
  rows.push({phase,stage:variant.name,...pair,reduction});
 }
 const report={kind:'offline-synthetic-visible-input',baselineRevision:'6cb1c70bd386a68f3b67f5b01e2e129befbb654c',unit:'UTF-8 bytes',definition:'subscription.serialize(actual budgeted messages) plus actual serialized output schema; opaque server wrappers and output excluded',actualModelCalls:0,actualTokens:null,rows};
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(rows.map(r=>({phase:r.phase,stage:r.stage,schema:[r.baseline.schemaBytes,r.candidate.schemaBytes],input:[r.baseline.fullInputBytes,r.candidate.fullInputBytes],reduction:r.reduction.fullInputBytes})),null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
