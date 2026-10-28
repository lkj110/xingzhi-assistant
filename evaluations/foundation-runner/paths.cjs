'use strict';
// Local path identity checks only. Native realpath resolves Windows 8.3 aliases;
// argument strings are left unchanged for the frozen subscription transport.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const equal=(a,b)=>path.relative(a,b)==='';
const identity=s=>({dev:String(s.dev),ino:String(s.ino)});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function capturePaths({temporaryRoot,cwd,schema,output}={}){
 const paths=Object.fromEntries(Object.entries({temporaryRoot,cwd,schema,output}).map(([name,raw])=>[name,{raw:typeof raw==='string'?raw:null,canonical:null,exists:null}]));
 let stage='path-capture';
 function fail(code,message,cause){const e=Object.assign(Error(message),{code:'RUNNER_PATH_'+code,stage,pathDiagnostics:clone(paths)});if(cause)e.pathErrorCode=String(cause.code||'UNKNOWN');throw e;}
 function check(condition,code,message){if(!condition)fail(code,message);}
 function absolute(name){const raw=paths[name].raw;check(typeof raw==='string'&&raw.length>0&&path.isAbsolute(raw)&&!raw.includes('\0'),'INPUT','An absolute '+name+' path is required');return raw;}
 function stat(name,target=absolute(name),optional=false){
  try{const s=fs.lstatSync(target,{bigint:true});paths[name].exists=true;return s;}
  catch(e){if(e.code==='ENOENT'){paths[name].exists=false;if(optional)return null;}fail('UNREADABLE','Cannot inspect '+name+' path',e);}
 }
 function canonical(name,target=absolute(name)){
  try{const result=fs.realpathSync.native(target);paths[name].canonical=result;return result;}catch(e){fail('UNREADABLE','Cannot resolve '+name+' path',e);}
 }
 function directory(name){const raw=absolute(name),s=stat(name,raw);check(s.isDirectory(),'DIRECTORY',name+' must be a directory');if(name==='cwd')check(!s.isSymbolicLink(),'LINK','Working directory must not be a link');const resolved=canonical(name,raw);return {resolved,identity:identity(s)};}
 function parentIdentity(target,name){try{const s=fs.statSync(target,{bigint:true});check(s.isDirectory(),'DIRECTORY',name+' parent must be a directory');return identity(s);}catch(e){if(e.code?.startsWith('RUNNER_PATH_'))throw e;fail('UNREADABLE','Cannot inspect '+name+' parent identity',e);}}
 function filePath(name,expected,cwdCanonical,cwdIdentity){
  const raw=absolute(name);check(path.basename(raw)===expected,'NAME',name+' must use the exact expected filename');
  let parent;try{parent=fs.realpathSync.native(path.dirname(raw));}catch(e){fail('UNREADABLE','Cannot resolve '+name+' parent',e);}
  paths[name].canonical=path.join(parent,expected);
  check(equal(parent,cwdCanonical)&&same(parentIdentity(parent,name),cwdIdentity),'OUTSIDE',name+' must be in the bound working directory');return raw;
 }
 function regular(name,target,optional=false){const s=stat(name,target,optional);if(!s)return null;check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n,'LINK',name+' must be a regular file with one link');return s;}
 function readSchema(raw){
  const before=regular('schema',raw),resolved=canonical('schema',raw);check(equal(resolved,path.join(paths.cwd.canonical,'schema.json')),'OUTSIDE','Schema resolved outside its expected location');
  let fd;try{fd=fs.openSync(raw,'r');const opened=fs.fstatSync(fd,{bigint:true});check(same(identity(before),identity(opened))&&opened.isFile()&&opened.nlink===1n,'CHANGED','Schema changed while opening');check(opened.size<=2000000n,'SIZE','Schema exceeds the path-check read limit');const bytes=fs.readFileSync(fd);const after=regular('schema',raw);check(same(identity(opened),identity(after)),'CHANGED','Schema changed while reading');return {identity:identity(opened),hash:hash(bytes),bytes};}
  catch(e){if(e.code?.startsWith('RUNNER_PATH_'))throw e;fail('UNREADABLE','Cannot read bound schema',e);}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 const temp=directory('temporaryRoot'),working=directory('cwd');
 check(equal(path.dirname(working.resolved),temp.resolved)&&same(parentIdentity(path.dirname(working.resolved),'cwd'),temp.identity)&&path.basename(working.resolved).startsWith('xingzhi-model-'),'OUTSIDE','Working directory must be an immediate xingzhi-model child of the temporary root');
 const schemaRaw=filePath('schema','schema.json',working.resolved,working.identity),outputRaw=filePath('output','response.json',working.resolved,working.identity),schemaBinding=readSchema(schemaRaw);
 check(!stat('output',outputRaw,true),'OUTPUT_EXISTS','Output must not exist before dispatch');
 const initialCanonical=clone(paths);let outputBinding;
 function revalidate({output:mode='optional'}={}){
  stage='path-revalidate';check(['absent','optional','required'].includes(mode),'INPUT','Invalid output validation mode');
  const currentTemp=directory('temporaryRoot'),currentCwd=directory('cwd');
  check(equal(currentTemp.resolved,temp.resolved)&&same(currentTemp.identity,temp.identity)&&equal(currentCwd.resolved,working.resolved)&&same(currentCwd.identity,working.identity),'CHANGED','Bound directory identity changed');
  check(equal(path.dirname(currentCwd.resolved),currentTemp.resolved)&&same(parentIdentity(path.dirname(currentCwd.resolved),'cwd'),currentTemp.identity),'OUTSIDE','Working directory escaped temporary root');
  const currentSchema=filePath('schema','schema.json',currentCwd.resolved,currentCwd.identity);filePath('output','response.json',currentCwd.resolved,currentCwd.identity);
  const current=readSchema(currentSchema);check(same(current.identity,schemaBinding.identity)&&current.hash===schemaBinding.hash,'CHANGED','Bound schema identity or content changed');
  const out=regular('output',outputRaw,true);
  if(mode==='absent')check(!out,'OUTPUT_EXISTS','Output appeared before dispatch');
  if(mode==='required')check(!!out,'OUTPUT_MISSING','Expected output was not created');
  if(out){const resolved=canonical('output',outputRaw);check(equal(resolved,path.join(currentCwd.resolved,'response.json')),'OUTSIDE','Output resolved outside its expected location');const next=identity(out);if(outputBinding)check(same(next,outputBinding),'CHANGED','Bound output identity changed');else outputBinding=next;}
  else{paths.output.canonical=initialCanonical.output.canonical;check(!outputBinding,'CHANGED','Bound output disappeared');}
  return clone(paths);
 }
 return {get paths(){return clone(paths);},cwd:working.resolved,output:initialCanonical.output.canonical,schemaBytes:Buffer.from(schemaBinding.bytes),revalidate};
}
module.exports={capturePaths};
