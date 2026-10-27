const {test}=require('node:test');
const assert=require('node:assert/strict');
const routing=require('../desktop/model-routing.cjs');
function fixture(){
 const providers=['gpt','deepseek','glm','gemma'].map(id=>({id}));
 return {data:{providers,settings:{scenarioModels:{enabled:true,subscription:'gpt',agent:'deepseek',complex:'glm',editorial:'gemma',customIds:['deepseek','glm','gemma']}}}};
}
test('Scenario policy keeps Agent stages and analysis on custom models, other work on subscription',()=>{
 const a=fixture(),p=a.data.providers[0];
 for(const options of [{role:'execute',stage:'planner'},{role:'execute',routingContext:{task:{title:'分析数据'}}}])
  assert.equal(routing.select(a,p,options).provider.id,'deepseek');
 assert.equal(routing.select(a,p,{role:'verify'}).provider.id,'glm');
 assert.equal(routing.select(a,p,{role:'execute',routingContext:{currentStep:{title:'精简报告'}}}).provider.id,'gemma');
 assert.equal(routing.select(a,p,{role:'organize',routingContext:{task:{title:'数据统计'}}}).provider.id,'deepseek');
 assert.equal(routing.select(a,p,{role:'organize'}).provider.id,'gpt');
 assert.equal(routing.select(a,p,{role:'organize',routingContext:{sources:[{id:'source'}]}}).provider.id,'deepseek');
 a.activeAgentJob={id:'job'};
 assert.equal(routing.select(a,p,{role:'organize'}).provider.id,'deepseek');
});
test('Scenario selection forbids fallback and fails closed when assigned provider is unavailable',()=>{
 const a=fixture(),p=a.data.providers[0],selection=routing.select(a,p,{role:'execute'});
 assert.equal(routing.allowsFallback(a,selection,p),false);
 a.data.providers.find(p=>p.id==='deepseek').archivedAt='now';
 assert.throws(()=>routing.select(a,p,{role:'execute'}),{code:'MODEL_CONFIG'});
});
test('Connection tests and evaluations preserve explicitly requested providers',()=>{
 const a=fixture(),p=a.data.providers[0];
 for(const stage of ['connection_test','evaluation'])assert.equal(routing.select(a,p,{stage}).provider,p);
});
