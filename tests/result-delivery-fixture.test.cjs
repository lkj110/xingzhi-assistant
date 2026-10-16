const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');

test('isolated native result fixture supports legacy and uiCommand calls without external work',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-result-fixture-'));
  const filename=path.resolve(__dirname,'../scripts/result-delivery-fixture.cjs');
  const localRequire=createRequire(filename);
  let setup,handler,assistant;
  t.after(()=>{if(assistant)localRequire('../desktop/deadline-scheduler.cjs').dispose(assistant);fs.rmSync(dir,{recursive:true,force:true});});
  const electron={
    app:{whenReady:()=>({then:fn=>(setup=Promise.resolve().then(fn))}),on:()=>{}},
    ipcMain:{handle:(name,fn)=>{assert.equal(name,'assistant:call');handler=fn;}},
    BrowserWindow:class{async loadFile(){}},
  };
  const context=vm.createContext({require:name=>name==='electron'?electron:localRequire(name),process:{env:{...process.env,ASSISTANT_TEST_DATA_DIR:dir}},__dirname:path.dirname(filename),console});
  vm.runInContext(fs.readFileSync(filename,'utf8'),context,{filename});await setup;
  assistant=vm.runInContext('a',context);
  const raw=(action,input)=>handler(null,action,input);
  const wrapped=(action,input)=>raw('uiCommand',{action,input});

  for(const [index,invoke] of [raw,wrapped,wrapped].entries())assert.equal((await invoke('agentOpenResult',{actionId:`action-${index}`})).data.ok,true);
  assert.deepEqual(Array.from((await raw('fixtureOpened')).data),['action-0','action-1','action-2']);
  assert.deepEqual(Array.from((await wrapped('fixtureOpened')).data),['action-0','action-1','action-2']);
  assert.match((await wrapped('agentOpenResult',{actionId:'missing'})).error,/执行记录不存在/);
  assert.match((await raw('agentOpenResult')).error,/执行记录不存在/);
  const before=assistant.data.artifacts[0].content;
  await wrapped('fixtureRevise');assert.equal(assistant.data.artifacts[0].content,before+' 尚未重新发布的修改');
  await raw('fixtureRevise');assert.equal(assistant.data.artifacts[0].content,before+' 尚未重新发布的修改'.repeat(2));
  for(const invoke of [raw,wrapped])assert.equal(JSON.stringify((await invoke('fixtureStats')).data),JSON.stringify({modelCalls:0,externalCalls:0}));

  // Real api.call must reach the native interception; core still receives the
  // original envelope on all other commands (and returns its lightweight view).
  const api=fs.readFileSync(path.resolve(__dirname,'../src/api.js'),'utf8').replace(/export /g,'');
  const apiContext=vm.createContext({window:{assistant:{desktop:true,call:raw}}});
  vm.runInContext(api,apiContext);
  assert.equal((await vm.runInContext("call('agentOpenResult',{actionId:'action-0'})",apiContext)).ok,true);
  assert.equal((await raw('fixtureOpened')).data.length,4);
  const dispatched=[];const dispatch=assistant.dispatch.bind(assistant);
  assistant.dispatch=(action,input)=>{dispatched.push({action,input});return dispatch(action,input);};
  const state=await wrapped('settings',{compactContext:false});
  assert.equal(dispatched[0].action,'uiCommand');
  assert.equal(state.error,undefined);assert.equal(state.data.settings.compactContext,false);
  assert.ok(state.data.viewRevision);assert.equal(state.data.artifacts[0].content,'');
});
