'use strict';
// Live-run admission only. This module consumes an existing user approval; it
// never creates an approval, restarts a stopped round, or contacts a model.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{isDeepStrictEqual}=require('node:util');
function fault(code,message,cause){return Object.assign(Error(message),{code,...(cause?{cause}:{}),scope:'global'});}
function canonicalOutput(output){
 if(typeof output!=='string'||!path.isAbsolute(output))throw fault('AUTH_OUTPUT','Output must be an absolute path');
 const suffix=[];let existing=path.resolve(output);
 while(!fs.existsSync(existing)){
  const parent=path.dirname(existing);if(parent===existing)throw fault('AUTH_OUTPUT','Output has no existing root');suffix.unshift(path.basename(existing));existing=parent;
 }
 if(!fs.statSync(existing).isDirectory())throw fault('AUTH_OUTPUT','Output or its ancestor is not a directory');
 return path.join(fs.realpathSync(existing),...suffix);
}
function claimAuthorization({authorizationPath,authorization,output,runnerIdentity,sealIdentity}){
 if(typeof authorizationPath!=='string'||!path.isAbsolute(authorizationPath))throw fault('AUTH_FILE','Authorization file must have an absolute path');
 if(!/^[a-f0-9]{64}$/.test(runnerIdentity||'')||!/^[a-f0-9]{64}$/.test(sealIdentity||''))throw fault('AUTH_IDENTITY','Invalid runner or sample identity');
 if(!authorization||authorization.grantedBy!=='user'||typeof authorization.reference!=='string'||!authorization.reference.trim())throw fault('AUTH_USER','An explicit user approval reference is required');
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(authorization.runId||''))throw fault('AUTH_RUN_ID','Approval must identify one UUID run');
 if(authorization.runnerIdentity!==runnerIdentity||authorization.sealIdentity!==sealIdentity)throw fault('AUTH_IDENTITY','Approval does not match this runner and sample seal');
 const outputDirectory=canonicalOutput(output);
 if(typeof authorization.outputDirectory!=='string'||!path.isAbsolute(authorization.outputDirectory)||path.resolve(authorization.outputDirectory)!==outputDirectory)throw fault('AUTH_OUTPUT','Approval does not match the canonical output directory');
 let canonicalAuthorizationPath,bytes,fileValue;
 try{
  canonicalAuthorizationPath=fs.realpathSync(authorizationPath);
  if(!fs.statSync(canonicalAuthorizationPath).isFile())throw Error('not a file');
  bytes=fs.readFileSync(canonicalAuthorizationPath);fileValue=JSON.parse(bytes.toString('utf8'));
 }catch(cause){throw fault('AUTH_FILE','Authorization file cannot be read as JSON',cause);}
 if(!isDeepStrictEqual(fileValue,authorization))throw fault('AUTH_CONTENT','Authorization argument differs from the approval file');
 const record={schema:1,runId:authorization.runId,outputDirectory,runnerIdentity,sealIdentity,authorizationSha256:crypto.createHash('sha256').update(bytes).digest('hex'),consumedAt:new Date().toISOString()};
 const consumedPath=canonicalAuthorizationPath+'.consumed.json';let fd;
 try{fd=fs.openSync(consumedPath,'wx',0o600);}catch(cause){throw fault(cause.code==='EEXIST'?'AUTH_CONSUMED':'AUTH_PERSIST',cause.code==='EEXIST'?'This approval has already been consumed':'Could not reserve this approval',cause);}
 try{fs.writeFileSync(fd,JSON.stringify(record,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;}
 catch(cause){throw fault('AUTH_PERSIST','Could not durably consume this approval; no live request is permitted',cause);}
 finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
 // Failed writes intentionally leave the exclusive marker in place. A partial
 // marker also forbids reuse; neither this module nor the runner removes it.
 return {...record,authorizationPath:canonicalAuthorizationPath,consumedPath};
}
module.exports={claimAuthorization};
