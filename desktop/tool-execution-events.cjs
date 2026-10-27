'use strict';
// Explicit tool invocations only. Validation/projection never creates an event.
const {hash}=require('./evidence-basis.cjs'),{randomUUID}=require('node:crypto');
function record(task,receipt,reused){
 const event={id:randomUUID(),taskId:task.id,receiptId:receipt.id,receiptHash:receipt.contentHash,requestHash:hash(receipt.request),at:new Date().toISOString(),kind:reused?'recomputed':'computed'};
 event.hash=hash(event);task.toolExecutions=[...(task.toolExecutions||[]),event].slice(-128);return event;
}
function rows(task,receipt){const all=task.toolExecutions||[],counts=new Map();for(const e of all)counts.set(e.id,(counts.get(e.id)||0)+1);return all.filter(e=>counts.get(e.id)===1&&typeof e.id==='string'&&Number.isFinite(Date.parse(e.at))&&['computed','recomputed'].includes(e.kind)&&e.taskId===task.id&&e.receiptId===receipt.id&&e.receiptHash===receipt.contentHash&&e.requestHash===hash(receipt.request)&&e.hash===hash({...e,hash:undefined}));}
function project(task,receipt){const all=rows(task,receipt);return {retainedCount:all.length,events:all.slice(-4).map(({id,at,kind})=>({id,at,kind})),omitted:Math.max(0,all.length-4),basis:hash(all),note:'仅记录显式请求的实际求值；结果可复用同一回执。校验器内部复算不计次，重复求值不是独立业务来源。'};}
module.exports={record,rows,project};
