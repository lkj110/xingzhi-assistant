'use strict';
const base=require('../foundation-native-ui-runner/policy.cjs');
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,names)=>object(v)&&Object.keys(v).every(k=>names.includes(k));
const reads=new Set(['state','stateView','export','viewDetail','acceptanceSnapshot','groundingStatus','readSource','readArtifact','quickCaptureDetectionStatus']);
function executorAllowed(action,input,taskId){
 if(!object(input))return false;
 if(['settings','saveProvider','captureSave','createTask'].includes(action))return true;
 if(action==='stop')return keys(input,[]);
 if(action==='advance')return keys(input,['id'])&&typeof taskId==='string'&&input.id===taskId;
 return action==='taskAction'&&keys(input,['id','command','note'])&&typeof taskId==='string'&&input.id===taskId&&input.command==='revise'&&typeof input.note==='string';
}
function classify(value){
 const {role,trusted,action,input,taskId,phase,human,granted,closed}=value;
 const inherited=base.classify(value);
 if(inherited.allowed&&['read','auxiliary'].includes(inherited.kind))return inherited;
 if(!trusted||role!=='main')return {allowed:false,reason:'untrusted-or-wrong-window'};
 if(granted&&executorAllowed(action,input,taskId)&&(!closed||action==='stop'))return {allowed:true,kind:'executor'};
 if(closed)return {allowed:false,reason:'closed-window'};
 if(phase!=='business'||!human?.valid||human.taskId!==taskId||typeof taskId!=='string'||action!=='uiCommand'||!keys(input,['action','input']))return {allowed:false,reason:'no-current-human-operation'};
 const args=input.input;
 if(human.kind==='accept'&&input.action==='taskAction'&&keys(args,['id','command'])&&args.id===taskId&&args.command==='accept')return {allowed:true,kind:'accept'};
 const expected=human.kind==='confirm'?'confirmGroundingMarkers':human.kind==='recheck'?'recheckGroundingMarkers':null;
 if(expected&&input.action===expected&&keys(args,['id','expectedReportHash'])&&args.id===taskId&&args.expectedReportHash===human.reportHash)return {allowed:true,kind:human.kind};
 return {allowed:false,reason:'human-operation-or-binding-mismatch'};
}
module.exports={classify,executorAllowed,isRead:action=>reads.has(action),inputSummary:base.inputSummary};
