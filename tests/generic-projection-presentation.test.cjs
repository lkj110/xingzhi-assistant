'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const acceptance=require('../desktop/acceptance.cjs');
test('presentation callbacks never serialize unrelated histories and refresh after await/in-place change',async t=>{
  const state={data:{agentRuns:{toJSON(){throw Error('unrelated history serialized');}}}},task={id:'t',version:1};
  let calls=0;
  t.mock.method(acceptance,'reasons',(_a,t,{completed})=>{calls++;return [{version:t.version,completed}];});
  const check=acceptance.presentationChecks(state),first=check(task);first[0].version=99;
  assert.deepEqual(check(task),[{version:1,completed:false}]);
  task.version=2;
  assert.deepEqual(check(task),[{version:2,completed:false}]);
  await Promise.resolve();task.version=3;
  assert.deepEqual(check(task,true),[{version:3,completed:true}]);
  assert.equal(calls,4);
});
test('presentation checks never cache an error or mistake it for an empty successful verdict',t=>{
  let corrupt=true,calls=0;
  t.mock.method(acceptance,'reasons',()=>{calls++;if(corrupt)throw Object.assign(Error('corrupt'),{code:'LOCAL_RESULT_INTEGRITY'});return [{code:'verification'}];});
  const check=acceptance.presentationChecks({data:{}});
  for(let i=0;i<2;i++)assert.throws(()=>check({id:'t'}),{code:'LOCAL_RESULT_INTEGRITY'});
  corrupt=false;assert.deepEqual(check({id:'t'}),[{code:'verification'}]);assert.equal(calls,3);
});
