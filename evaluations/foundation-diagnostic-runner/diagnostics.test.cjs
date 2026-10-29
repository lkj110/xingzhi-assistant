'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{collector,redact,limits}=require('./diagnostics.cjs');
const failed={started:true,exitCode:78,processTreeConfirmed:true,usageUnknown:true,usageEvents:0,code:'CLI_PROTOCOL_REJECTION'};
test('split chunks and a final line without newline retain failure details, not sensitive fields',()=>{
 const c=collector(),raw=JSON.stringify({type:'turn.failed',error:{code:'provider_unavailable',message:'Temporary upstream rejection',http_status:503,request_id:'request-1',retryable:true,authorization:'SYNTHETIC_SECRET',body:'SYNTHETIC_PRIVATE'}});
 for(let i=0;i<raw.length;i+=7)c.feed({channel:'stdout',data:raw.slice(i,i+7)});const d=c.finish(failed,failed);assert.equal(d.events[0].details.error.message,'Temporary upstream rejection');assert.equal(d.events[0].details.error.code,'provider_unavailable');assert.equal(d.events[0].details.error.http_status,503);assert.equal(d.terminal.usageUnknown,true);assert.equal(d.terminal.exitCode,78);assert.ok(!JSON.stringify(d).includes('SYNTHETIC_SECRET'));assert.ok(!JSON.stringify(d).includes('SYNTHETIC_PRIVATE'));
});
test('credential values and embedded request blocks are removed before clipping',()=>{
 for(const value of ['Authorization: Basic SYNTHETIC_SECRET_BASE64','cookie: session=SYNTHETIC_COOKIE_ONE; refresh=SYNTHETIC_COOKIE_TWO','messages=[{"role":"user","content":"SYNTHETIC_PRIVATE_SOURCE"}]','request_body={"text":"SYNTHETIC_PRIVATE_SOURCE"}','server data: {\\"password\\":\\"SYNTHETIC_PRIVATE_PASSWORD\\"}','server data: {\\"messages\\":[{\\"content\\":\\"SYNTHETIC_PRIVATE_SOURCE\\"}]}','password="first word\nSYNTHETIC_SECRET_SECOND_LINE"','Bearer SYNTHETIC_SECRET_TOKEN','https://user:SYNTHETIC_SECRET@host.test/x?token=SYNTHETIC_QUERY'])assert.ok(!redact(value).includes('SYNTHETIC_'),value);
 const c=collector();c.feed({channel:'stderr',data:'HTTP failure Authorization: Ba'});c.feed({channel:'stderr',data:'sic SYNTHETIC_SECRET_BASE64\nrefresh=SYNTHETIC_SECRET_MORE'});const d=c.finish(failed,failed);assert.ok(!JSON.stringify(d).includes('SYNTHETIC_SECRET'));
});
test('request text echoed in an error is redacted; unknown payload fields are excluded',()=>{
 const privateText='本段合成私密原文不应出现在诊断正文中';const c=collector({requestInput:JSON.stringify([{role:'user',content:JSON.stringify({sources:[{content:privateText}]})}])});
 c.feed({channel:'stdout',data:JSON.stringify({type:'error',message:'Cannot process '+privateText,payload:{prompt:privateText},stack:privateText})+'\n'});const d=c.finish(failed,failed);assert.ok(!JSON.stringify(d).includes(privateText));assert.match(d.events[0].details.message,/REDACTED_REQUEST_TEXT/);
});
test('oversized lines/stderr and repeated errors have bounded diagnostic storage',()=>{
 const c=collector();c.feed({channel:'stdout',data:JSON.stringify({type:'error',message:'x'.repeat(limits.lineBytes+1)})+'\n'});for(let i=0;i<8;i++)c.feed({channel:'stdout',data:JSON.stringify({type:'error',message:'m'.repeat(6000)})+'\n'});c.feed({channel:'stderr',data:'x'.repeat(limits.stderrBytes+1)});const d=c.finish(failed,failed);assert.equal(d.discardedLines,1);assert.equal(d.events.length,limits.events);assert.equal(d.droppedEvents,4);assert.equal(d.stderr.text,null);assert.equal(d.stderr.omittedForSize,true);assert.ok(Buffer.byteLength(JSON.stringify(d))<=limits.diagnosticBytes);
});
test('known usage before failure remains known; diagnostics invent no usage',()=>{
 const c=collector();c.feed({channel:'stdout',data:'{"type":"error","message":"failure"}\n'});const d=c.finish({...failed,usage:{inputTokens:10,outputTokens:2},usageUnknown:false,usageEvents:1},failed);assert.equal(d.terminal.authoritativeUsagePresent,true);assert.equal(d.terminal.usageUnknown,false);assert.equal(d.usage,undefined);
});
