'use strict';
const cp=require('node:child_process'),crypto=require('node:crypto');
const helper=()=>require('./windows-native.cjs').nativePath('bin/windows-process.exe');
const managed=new WeakMap();
function spawn(file,args,options={}){
  if(process.platform!=='win32')return cp.spawn(file,args,options);
  const id=crypto.randomUUID(),child=cp.spawn(helper(),['run',String(process.pid),id,file,...args],{...options,detached:false,windowsHide:true});
  const state={closed:false,confirmed:false};managed.set(child,state);
  child.on('error',()=>{state.confirmed=false;});
  child.on('close',(code,signal)=>{state.closed=true;state.confirmed=Number.isInteger(code)&&code!==254&&!signal;});
  child.kill=()=>{
    if(state.closed)return false;
    // Cooperative cancellation leaves the supervisor alive until the entire Job is empty.
    const result=cp.spawnSync(helper(),['cancel',id],{stdio:'ignore',windowsHide:true,timeout:3000});
    return !result.error&&result.status===0;
  };
  return child;
}
function confirmed(child){return managed.get(child)?.confirmed===true;}
function secure(file){cp.execFileSync(helper(),['secure',file],{stdio:'pipe',windowsHide:true,timeout:5000});}
function check(files){return JSON.parse(cp.execFileSync(helper(),['check',...files],{encoding:'utf8',windowsHide:true,timeout:5000}));}
module.exports={spawn,confirmed,secure,check,managed:child=>managed.has(child)};
