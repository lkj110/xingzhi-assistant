'use strict';
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const keys=(v,names)=>object(v)&&Object.keys(v).every(k=>names.includes(k));
const empty=v=>v===undefined||keys(v,[])&&Object.keys(v).length===0;
const READS=new Set(['state','stateView','export','viewDetail','acceptanceSnapshot','groundingStatus','readSource','readArtifact','quickCaptureDetectionStatus']);
function classify({role,trusted,action,input,taskId,closed}){
 if(!trusted)return {allowed:false,reason:'untrusted-sender'};
 const command=action==='uiCommand'?input?.action:action;
 if(role==='main'&&READS.has(action)&&action===command)return {allowed:true,kind:'read'};
 if(closed)return {allowed:false,reason:'closed-window'};
 if(role==='capture'){
  if(action==='quickCaptureState'&&(empty(input)||keys(input,['receiptId'])&&typeof input.receiptId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.receiptId)))return {allowed:true,kind:'auxiliary'};
  if(action==='quickCaptureDraft'&&keys(input,['occupied'])&&typeof input.occupied==='boolean')return {allowed:true,kind:'auxiliary'};
  if(action==='quickCaptureHide'&&empty(input))return {allowed:true,kind:'auxiliary'};
  return {allowed:false,reason:'capture-command-or-input'};
 }
 if(role==='main'&&action==='uiCommand'&&keys(input,['action','input'])&&input.action==='taskAction'&&keys(input.input,['id','command'])&&input.input.id===taskId&&input.input.command==='accept')return {allowed:true,kind:'accept'};
 return {allowed:false,reason:'main-command-or-input'};
}
function inputSummary(value){
 if(!object(value))return {type:value===null?'null':Array.isArray(value)?'array':typeof value};
 return {type:'object',keys:Object.keys(value).slice(0,12).map(k=>k.slice(0,64)),fieldCount:Object.keys(value).length};
}
module.exports={classify,inputSummary};
