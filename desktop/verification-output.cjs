'use strict';
// Subscription transport contract only. Semantic support, access, scope and
// delivery still pass through the existing independent/local validators.
const PREFIX='grounding-output-v2',ID=PREFIX+'-read-bcr',FINAL_ID=PREFIX+'-final',optionalNodes=new WeakSet();
const str={type:'string'},bool={type:'boolean'},int={type:'integer'};
const choice=(...values)=>({type:typeof values[0],enum:values});
const array=items=>({type:'array',items});
const optional=node=>{const value={anyOf:[node,{type:'null'}]};optionalNodes.add(value);return value;};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const strings=array(str),position=()=>optional(int);
const qualification=object({field:str,quote:str,start:position()});
const citation=object({id:str,sourceId:str,quote:str,start:position()});
const claim=object({id:str,artifactId:str,field:choice('content','artifactTitle','taskTitle','actionTitle'),text:str,kind:choice('fact','inference','unknown','proposal'),supported:bool,citationIds:strings,reason:optional(str),start:position(),actionId:optional(str),qualification:optional(qualification)});
const requirement=object({id:str,status:choice('satisfied','gap','deferred'),claimIds:strings,reason:optional(str),deferredStepId:optional(str)});
const sourceConflict=object({disposition:choice('disclosed_unknown'),claimIds:strings,requirementIds:strings,citationIds:strings,reason:str});
const anchor=object({artifactId:str,quote:str,start:position(),end:position()});
const consistency=object({claimIds:strings,anchors:array(anchor),reason:str});
const review=object({format:choice('compact-v5'),scannedArtifactIds:strings,citations:array(citation),requirements:array(requirement),claims:array(claim),unsupportedClaims:array({anyOf:[str,object({claimId:str,reason:str})]}),conflicts:array({anyOf:[str,object({claimIds:strings,citationIds:strings,reason:str})]}),consistencyIssues:array(consistency),sourceConflicts:optional(array(sourceConflict))});
const gap=object({requirementId:optional(str),text:str,sourceIds:optional(strings),relationKind:optional(str),rootIds:optional(strings),artifactId:optional(str),stepId:optional(str),kind:optional(choice('text','evidence','binding','delivery'))});
const coverage=object({obligationId:str,status:str,coverage:str,rootIds:strings,sourceIds:strings,summary:str});
const report=object({passed:bool,summary:str,gaps:strings,groundingReview:review,gapDetails:optional(array(gap)),relationCoverage:optional(array(coverage)),suggestions:optional(strings)});
// The schema offers valid shapes, not permission. Existing tool validators
// reject unsupported combinations and bind every request to the current scope.
const read=object({tool:choice('read_source','search_source','read_section','read_artifact','read_segment'),ref:optional(str),sourceId:optional(str),artifactId:optional(str),start:position(),history:optional(bool),version:optional(str),contextRevision:optional(str),limit:position(),query:optional(str),title:optional(str),index:position()});
const list=object({tool:choice('list_sources'),query:optional(str),start:position(),limit:position(),history:optional(bool),ref:optional(str),type:optional(choice('source','artifact')),taskId:optional(str)});
const search=object({tool:choice('search_evidence'),query:str,limit:position(),sourceId:optional(str),ref:optional(str)});
const obligations=object({tool:choice('read_obligations'),taskId:optional(str),obligationId:optional(str),section:optional(str),start:position(),limit:position(),contextRevision:optional(str),coverageVersion:optional(str),path:optional(array({anyOf:[str,int]}))});
const boundInput=object({sourceId:str,start:position(),end:position(),whole:optional(bool),unit:optional(str)});
const filter=object({column:str,op:choice('eq','ne','lt','lte','gt','gte','contains'),inputIndex:int});
const args=object({unit:optional(str),scale:position(),rounding:optional(choice('half_even','half_up','truncate')),to:optional(str),timeZone:optional(str),format:optional(choice('csv','json')),filter:optional(filter)});
const compute=object({tool:choice('compute_evidence'),operation:choice('sum','ratio','convert_unit','date_days','elapsed','timezone','count','file_observation','action_status'),inputs:optional(array(boundInput)),args:optional(args),actionId:optional(str)});
// Both wire schemas and the local decoder derive from these same typed nodes.
// Keep null removal local to explicitly optional slots; schema compaction never
// changes the report fields or any evidence/semantic decision.
function wire(node,{inline=false}={}){
 if(node===strings&&!inline)return {$ref:'#/$defs/ids'};
 if(optionalNodes.has(node)){
  const value=wire(node.anyOf[0],{inline:true});
  return {...value,type:[value.type,'null'],...(value.enum?{enum:[...value.enum,null]}:{})};
 }
 return Object.fromEntries(Object.entries(node).map(([key,value])=>[key,
  key==='properties'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,wire(v)])):
  key==='items'?wire(value):key==='anyOf'?value.map(v=>wire(v)):value]));
}
function select({final=false,search=true,compute=true,retryFull=true}={}){
 return final?FINAL_ID:PREFIX+'-read-'+((search?'b':'')+(compute?'c':'')+(retryFull?'r':'')||'plain');
}
const contracts=new Map();
function build(id,response){
 const raw=object({response_json:response}),schema={...wire(raw),$defs:{ids:wire(strings,{inline:true})}};
 const serialized=JSON.stringify(schema),metadata={id,sha256:require('node:crypto').createHash('sha256').update(serialized).digest('hex'),chars:serialized.length,utf8Bytes:Buffer.byteLength(serialized,'utf8')};
 const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
 contracts.set(id,{raw,public:freeze({id,schema,serialized,metadata})});
}
for(const searchEnabled of [false,true])for(const computeEnabled of [false,true])for(const retryFull of [false,true]){
 const tools=[read,list,obligations,...(searchEnabled?[search]:[]),...(computeEnabled?[compute]:[])];
 build(select({search:searchEnabled,compute:computeEnabled,retryFull}),{anyOf:[report,object({kind:choice('read_context'),requests:array({anyOf:tools})}),...(retryFull?[object({retryFull:choice(true)})]:[]),object({kind:choice('need_input'),question:str})]});
}
build(FINAL_ID,report);
function selected(options){return contracts.has(options?.responseContract);}
function get(id=ID){
 const entry=contracts.get(id);
 if(!entry)throw require('./model-errors.cjs').modelError('MODEL_CONFIG','核验输出协议不可用，已停止发送。',false);
 return entry.public;
}
function overhead(provider,options){return provider.type==='codex'&&options?.responseContract!==undefined?get(options.responseContract).metadata:null;}
const {schema,serialized,metadata}=get();
// Match BEFORE dropping null: only explicitly optional slots may disappear.
// No coercion, guessed syntax, removal of unknown properties or semantic repair.
function normalize(value,node){
 if(node.anyOf){for(const branch of node.anyOf)try{return normalize(value,branch);}catch{}throw Error('union');}
 if(node.enum&&!node.enum.includes(value))throw Error('enum');
 if(node.type==='null'){if(value!==null)throw Error('null');return null;}
 if(node.type==='array'){if(!Array.isArray(value))throw Error('array');return value.map(v=>normalize(v,node.items));}
 if(node.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(node.properties,k)))throw Error('object');
  const out={};for(const [key,field] of Object.entries(node.properties)){
   if(!Object.hasOwn(value,key)){if(optionalNodes.has(field))continue;throw Error('required');}
   const child=normalize(value[key],field);if(child===null&&optionalNodes.has(field))continue;
   Object.defineProperty(out,key,{value:child,enumerable:true,writable:true,configurable:true});
  }return out;
 }
 if(node.type==='integer'?!Number.isSafeInteger(value):typeof value!==node.type)throw Error('type');return value;
}
function decode(value,id=ID){
 get(id);
 try{return normalize(typeof value==='string'?require('./model-json.cjs').parse(value):value,contracts.get(id).raw).response_json;}
 catch{
  const error=require('./model-errors.cjs').modelError('MODEL_INVALID_RESPONSE','订阅核验结果不符合结构协议，已保留进度；不会通过猜测或删改内容修复。',false);
  // Preserve a bounded original for explicit private evaluation/debug capture,
  // as model-json does. It is never serialized to logs or a repair prompt here.
  if(typeof value==='string'&&value.length<=2_000_000)Object.defineProperty(error,'responseText',{value,enumerable:false});
  throw error;
 }
}
module.exports={ID,FINAL_ID,select,get,schema,serialized,metadata,selected,overhead,decode};
