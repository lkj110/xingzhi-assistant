'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {root,sha,write,inside}=require('./common.cjs'),{Ledger,normalizeUsage}=require('./ledger.cjs');
const {runTransport,environment}=require('./transport.cjs');
const guard=require('./protocol-guard.cjs');
const protocol=require(path.join(root,'desktop/subscription-protocol.cjs'));
const schema={type:'object',properties:{response_json:{type:'string'}},required:['response_json'],additionalProperties:false};
function invocation(body,plan){
 assert.ok(body&&Array.isArray(body.args)&&body.args.every(a=>typeof a==='string'));assert.equal(typeof body.input,'string');
 const args=body.args,si=args.indexOf('--output-schema'),oi=args.indexOf('--output-last-message');assert.ok(si>0&&oi>0);
 const tmp=fs.realpathSync(os.tmpdir()),cwd=fs.realpathSync(body.cwd);assert.ok(inside(tmp,cwd)&&path.basename(cwd).startsWith('xingzhi-model-'));
 assert.equal(args[si+1],path.join(cwd,'schema.json'));assert.equal(args[oi+1],path.join(cwd,'response.json'));
 const expected=['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--color','never','--json','--model',plan.model.id,...protocol.configuration(),'-c',`model_reasoning_effort=${JSON.stringify(plan.model.reasoning)}`,'--output-schema',args[si+1],'--output-last-message',args[oi+1],'-'];
 assert.deepEqual(args,expected,'CLI protocol changed');const schemaBytes=fs.readFileSync(args[si+1]);assert.deepEqual(JSON.parse(schemaBytes),schema);
 const prefix=protocol.instructions+'\nAPPLICATION MESSAGES:\n';assert.ok(body.input.startsWith(prefix));const messages=JSON.parse(body.input.slice(prefix.length));
 assert.equal(protocol.serialize(messages),body.input);assert.ok(!body.input.includes('FOUNDATION_GOLD_ONLY_'));
 const payload=JSON.parse(messages[1].content),role=payload.groundingReviewRequest?'verify':'execute';
 return {messages,payload,role,stage:role==='verify'?'task_verify':'task_work',output:args[oi+1],cwd,schemaBytes:schemaBytes.length,serializedInputBytes:Buffer.byteLength(body.input),visibleBytes:Buffer.byteLength(JSON.stringify(messages))};
}
async function createBroker({directory,plan,mode,sealIdentity,authorization,realCli,fixture,identityGuard,fault}){
 assert.ok(['offline','live'].includes(mode));if(mode==='live'){assert.ok(realCli&&path.isAbsolute(realCli));assert.equal(fixture,undefined);}
 assert.ok(!fault||mode==='offline');assert.equal(typeof identityGuard,'function');
 const nonce=crypto.randomBytes(32).toString('hex'),ledger=new Ledger({dir:path.join(directory,'ledger'),plan,mode,sealIdentity,authorization,conservativeAttemptSlot:true});
 let context,busy=false,stopped=false,activeCancel;const rows=[],errors=[],active=new Set();
 const frame=(res,value)=>{if(!res.destroyed)res.write(JSON.stringify(value)+'\n');};
 const fail=(id,reason)=>{stopped=true;activeCancel?.();errors.push(reason);try{if(id)ledger.fail(id,reason);else ledger.stop(reason);}catch(e){errors.push(e.message);}};
 function terminal(record,call){
  if(!record)return;let rawOutput=null,outputReadError=null;
  try{if(call?.output){assert.ok(fs.statSync(call.output).size<=2000000);rawOutput=fs.readFileSync(call.output,'utf8');}}catch(e){outputReadError=e.code||e.message;}
  const audit=path.join(directory,'calls');fs.mkdirSync(audit,{recursive:true});
  write(path.join(audit,record.attemptId+'-terminal.json'),{...record,rawOutput,outputReadError});
 }
 const server=http.createServer(async(req,res)=>{
  let attempt,record,ownedBusy=false,applicationEntry=false,body,call;
  try{
   assert.equal(req.method,'POST');assert.equal(req.url,'/cli');assert.equal(req.headers['x-runner-nonce'],nonce);
   let size=0;const pieces=[];for await(const b of req){size+=b.length;assert.ok(size<2000000);pieces.push(b);}body=JSON.parse(Buffer.concat(pieces));
   assert.ok(context&&!stopped,'No active case or round stopped');assert.equal(busy,false,'Concurrent CLI request');
   applicationEntry=body.args?.[0]==='exec'||JSON.stringify(body.args)===JSON.stringify(['login','status']);
   busy=true;ownedBusy=true;
   res.writeHead(200,{'Content-Type':'application/x-ndjson'});
   if(JSON.stringify(body.args)===JSON.stringify(['login','status'])){
    if(mode==='offline'){frame(res,{channel:'stdout',data:'Logged in using ChatGPT (SYNTHETIC OFFLINE)\n'});frame(res,{channel:'done',code:0});res.end();return;}
    // Only the login check issued by frozen subscription.chat, never an added probe.
    const r=cp.spawnSync(realCli,['login','status'],{windowsHide:true,encoding:'utf8',timeout:15000,env:environment()});
    if(r.error||r.status!==0||!/Logged in using ChatGPT/.test(r.stdout+r.stderr))throw Error('CLI_LOGIN_FAILED');
    frame(res,{channel:'stdout',data:r.stdout});frame(res,{channel:'stderr',data:r.stderr});frame(res,{channel:'done',code:0});res.end();return;
   }
   identityGuard();call=invocation(body,plan);guard.request(call.messages,call.payload,context);attempt=ledger.admit({caseId:context.id,role:call.role,stage:call.stage,serializedInputBytes:call.serializedInputBytes,schemaBytes:call.schemaBytes,visibleBytes:call.visibleBytes});
   record={caseId:context.id,attemptId:attempt.id,role:call.role,stage:call.stage,inputSha256:sha(body.input),serializedInputBytes:call.serializedInputBytes,schemaBytes:call.schemaBytes,visibleBytes:call.visibleBytes,synthetic:mode==='offline',transportDispatched:false};rows.push(record);
   const audit=path.join(directory,'calls');fs.mkdirSync(audit,{recursive:true});write(path.join(audit,attempt.id+'-request.json'),{...record,messages:call.messages});
   let result;
   if(mode==='offline'){
    const response=await fixture({context,...call});
    const usage={inputTokens:Math.ceil(call.serializedInputBytes/3),outputTokens:200,cachedInputTokens:0};
    fs.writeFileSync(call.output,fault==='malformed-envelope'?'invalid-envelope':JSON.stringify({response_json:fault==='malformed-inner'?'invalid-json':JSON.stringify(response)}));
    frame(res,{channel:'stdout',data:JSON.stringify({type:'turn.completed',...(fault==='unknown-usage'?{}:{usage:{input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,cached_input_tokens:0}})})+'\n'});
    result={usage:fault==='unknown-usage'?undefined:usage,code:0,usageEvents:1};
   }else {
    const controller=new AbortController();activeCancel=()=>controller.abort();res.on('close',()=>controller.abort());record.transportDispatched=true;
    const pending=runTransport({bin:realCli,args:body.args,input:body.input,cwd:body.cwd,env:environment(),timeoutMs:plan.budget.perCallTimeoutMs,idleTimeoutMs:plan.budget.perCallIdleMs,signal:controller.signal,onFrame:value=>frame(res,value)});
    active.add(pending);try{result=await pending;}finally{active.delete(pending);activeCancel=null;}
   }
   record.rawUsageEvents=result.rawUsageEvents||[{synthetic:true,usage:result.usage}];record.processTreeConfirmed=result.processTreeConfirmed??mode==='offline';
   ledger.settle(attempt.id,result.usage);record.usage=result.usage;record.usageEvents=result.usageEvents;
   assert.ok(fs.statSync(call.output).size<=2000000);record.outputSha256=sha(fs.readFileSync(call.output));
   guard.response(fs.readFileSync(call.output,'utf8'),call);
   terminal(record,call);record.terminalPersisted=true;
   frame(res,{channel:'done',code:0});res.end();
  }catch(e){
   if(record){record.error=e.code||e.message;record.errorDetail=e.message;record.rawUsageEvents=e.rawUsageEvents||record.rawUsageEvents||[];record.processTreeConfirmed=e.processTreeConfirmed??record.processTreeConfirmed;}
   if(attempt){if(e.usage&&!e.usageUnknown)try{ledger.settle(attempt.id,e.usage);if(record)record.usage=e.usage;}catch{}fail(attempt.id,e.code||e.message);}
   else if(e.attemptId){record={caseId:context.id,attemptId:e.attemptId,role:call?.role,stage:call?.stage,transportDispatched:false,error:e.code,errorDetail:e.message};rows.push(record);if(e.scope!=='case')fail(null,e.code||e.message);}
   else if(applicationEntry){const local=ledger.localReject({caseId:context.id,role:call?.role||'unknown',stage:call?.stage||'preflight'},e.code+': '+e.message);record={caseId:context.id,attemptId:local.id,transportDispatched:false,localRejected:true,error:e.code,errorDetail:e.message,inputSha256:sha(body.input||'')};rows.push(record);fail(null,e.code||e.message);}
   else fail(null,e.code||e.message);
   try{if(record&&!record.terminalPersisted)terminal(record,call);}catch(auditError){fail(null,'AUDIT_PERSISTENCE_FAILED: '+auditError.message);}
   if(!res.headersSent)res.writeHead(200,{'Content-Type':'application/x-ndjson'});
   frame(res,{channel:'stderr',data:'Evaluation guard stopped: '+(e.code||e.message)+'\n'});frame(res,{channel:'done',code:78});res.end();
  }finally{if(ownedBusy)busy=false;}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {ledger,rows,errors,get stopped(){return stopped;},get busy(){return busy;},
  bridgeConfig:{url:`http://127.0.0.1:${server.address().port}/cli`,nonce},
  setContext(c){assert.equal(busy,false);assert.equal(stopped,false);context=c;},
  cancel(reason='RUNNER_CANCELLED'){fail(null,reason);activeCancel?.();},
  async close(){activeCancel?.();await Promise.allSettled([...active]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
 };
}
module.exports={createBroker,invocation};
