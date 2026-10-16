const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(require('node:path').join(__dirname,'../src/agent-progress.js'))).toString('base64'));
test('Old recovery diagnostics do not masquerade as current failures after review or success',async()=>{
 const {recoveryNotice}=await modulePromise;
 for(const status of ['review','completed','paused','needs_input','blocked'])assert.equal(recoveryNotice({id:'j',status,autoRecovery:{status:'scheduled',errorCode:'MODEL_INVALID_RESPONSE'}},[]),'');
 for(const status of ['superseded','recovered'])assert.equal(recoveryNotice({id:'j',status:'running',autoRecovery:{status}},[]),'');
});
test('Active retries and automatic editing are distinguished from execution failures',async()=>{
 const {recoveryNotice}=await modulePromise;
 assert.match(recoveryNotice({id:'j',status:'retry',autoRecovery:{status:'scheduled'}},[]),/等待重试/);
 assert.match(recoveryNotice({id:'j',status:'running',autoRecovery:{status:'recovering'}},[]),/正在恢复/);
 const job={id:'j',status:'running'},task={agentJobId:'j',status:'todo',autoRepair:{attempt:2}};
 assert.match(recoveryNotice(job,[task]),/第 2 轮检查意见修订/);
 assert.equal(recoveryNotice(job,[{...task,status:'review',verification:{passed:true}}]),'');
 assert.equal(recoveryNotice(job,[{...task,deletedAt:'now'}]),'');
});
