const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),policies=require('../desktop/access-policy-store.cjs'),rules=require('../desktop/work-rules.cjs');
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rule-policy-v3-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir,chat:async()=>{throw Error('No model calls expected');}});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 await a.dispatch('ruleSave',{name:'Daily local work',goal:'整理已收集材料',trigger:'daily',enabled:true,allowWeb:false});
 return {a,rule:a.data.workRules[0]};
}
test('A scheduled rule cannot manufacture a new model grant after its own authorization was revoked',async t=>{
 const {a,rule}=await setup(t);
 policies.revoke(a,{principalScope:policies.LOCAL,resourceScope:{kind:'model',key:'app',jobId:'rule:'+rule.id},operations:['model','model_request']},{trusted:true,actor:'user_command',command:'test revoke'});
 await rules.check(a,rule,{force:true});
 assert.equal(a.data.delegations.length,0);assert.equal(a.data.ruleRuns[0].status,'error');assert.match(a.data.ruleRuns[0].error,/授权/);
});
test('Restoring an archived rule projection does not restore the independent permission',async t=>{
 const {a,rule}=await setup(t),old=structuredClone(rule);
 await a.dispatch('ruleArchive',{id:rule.id});
 a.data.workRules=[old];await rules.check(a,old,{force:true});
 assert.equal(a.data.delegations.length,0);assert.equal(a.data.ruleRuns[0].status,'error');
});
