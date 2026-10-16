const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const protocol=require('../desktop/subscription-protocol.cjs'),errors=require('../desktop/model-errors.cjs');
for(const type of ['command_execution','mcp_tool_call','web_search','file_change','collab_agent_tool_call','image_generation_call','computer_call'])test(`host ${type} is stopped without automatic replay or leaking payloads`,()=>{
 const e=protocol.hostToolError({type,status:'in_progress',arguments:'PRIVATE',output:'PRIVATE',server:'PRIVATE'});
 assert.equal(e.automaticRetry,false);assert.equal(e.jsonRepairable,undefined);assert.equal(errors.fallbackEligible(e),false);
 assert.deepEqual(errors.diagnostic(e),{source:'codex_cli',kind:'host_tool_attempt',itemType:type,itemStatus:'in_progress'});
 assert.ok(!JSON.stringify(e).includes('PRIVATE'));
});
test('application proposals and ordinary messages are not host invocations',()=>{
 for(const item of [null,{type:'agent_message',text:'{"tool":"platform_query"}'},{type:'reasoning'},{type:'todo_list'}])assert.equal(protocol.hostToolError(item),null);
 assert.deepEqual(errors.diagnostic({diagnostic:{source:'codex_cli',kind:'host_tool_attempt',itemType:'PRIVATE',itemStatus:'PRIVATE',arguments:'PRIVATE'}}),{source:'codex_cli',kind:'host_tool_attempt'});
});
test('actual CLI launch isolates plugins, skills and tool families while preserving sandbox and accounting',async()=>{
 const vm=require('node:vm'),{EventEmitter}=require('node:events'),createRequire=require('node:module').createRequire;
 const filename=path.resolve(__dirname,'../desktop/subscription.cjs'),realRequire=createRequire(filename);let execArgs,usage,kills=0,withHostCall=false;
 const spawn=(_bin,args)=>{const child=new EventEmitter();child.pid=12345;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=input=>queueMicrotask(()=>{
  if(args[0]==='login')child.stdout.emit('data',Buffer.from('Logged in using ChatGPT'));
  else {execArgs=args;assert.match(input,/APPLICATION MESSAGES/);
   fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({response_json:'{"tool":"platform_query","args":{}}'}));
   const events=withHostCall?[{type:'item.started',item:{type:'mcp_tool_call',status:'in_progress',arguments:'PRIVATE'}},{type:'item.completed',item:{type:'command_execution',status:'completed'}}]:[];
   events.push({type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:30}});
   child.stdout.emit('data',Buffer.from(events.map(x=>JSON.stringify(x)).join('\n')+'\n'));
  }child.emit('close',0);
 });return child;};
 const fakeFS={...fs,statSync:p=>String(p).endsWith('/codex')?{isFile:()=>true}:fs.statSync(p),accessSync:p=>String(p).endsWith('/codex')?undefined:fs.accessSync(p)};
 const context={module:{exports:{}},process:{env:{PATH:'/fixture'},kill:()=>kills++},Buffer,setTimeout,clearTimeout,require:n=>n==='node:fs'?fakeFS:n==='node:child_process'?{spawn}:realRequire(n)};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),context);
 const value=await context.module.exports.chat({model:'fixture'},'',[],{onUsage:u=>usage=u});assert.equal(value.tool,'platform_query');
 assert.equal(execArgs[execArgs.indexOf('--sandbox')+1],'read-only');assert.ok(execArgs.includes('--ignore-user-config'));assert.ok(execArgs.includes('--ephemeral'));
 for(const feature of ['shell_tool','apps','plugins','remote_plugin','computer_use','browser_use','code_mode_host','skill_search','multi_agent','image_generation','workspace_dependencies'])assert.ok(execArgs.includes(`features.${feature}=false`),feature);
 assert.ok(execArgs.includes('features.skip_host_skill_discovery=true'));assert.ok(execArgs.includes('skills.include_instructions=false'));assert.ok(execArgs.includes('skills.bundled.enabled=false'));assert.ok(execArgs.includes('web_search="disabled"'));assert.ok(execArgs.includes(`developer_instructions=${JSON.stringify(protocol.instructions)}`));
 assert.equal(usage.inputTokens,100);assert.equal(usage.cachedInputTokens,30);
 withHostCall=true;await assert.rejects(context.module.exports.chat({model:'fixture'},'',[],{onUsage:u=>usage=u}),e=>e.automaticRetry===false&&e.diagnostic.itemType==='mcp_tool_call');
 assert.ok(kills>0);assert.equal(usage.outputTokens,20); // Usage following the stop remains accounted.
});
