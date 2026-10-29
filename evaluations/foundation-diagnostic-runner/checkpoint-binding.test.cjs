'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{binding,unchanged}=require('./checkpoint-binding.cjs');
const state=()=>({tasks:[{id:'t',status:'review',primaryArtifactId:'a',title:'Task',description:'Input',criteria:'Criterion',sourceIds:['s'],steps:[{artifactId:'a',done:true}],grounding:{passed:true,reportHash:'r'},verification:{passed:true}}],artifacts:[{id:'a',taskId:'t',title:'Draft',content:'Fact'}],sources:[{id:'s',content:'Fact'}]});
test('approved checkpoint must still bind the same draft, requirements, source and report',()=>{
 const original=state(),hash=binding(original,'t');unchanged(hash,original,'t');
 for(const change of [s=>s.artifacts[0].content='Changed',s=>s.tasks[0].criteria='Changed',s=>s.sources[0].content='Changed',s=>s.tasks[0].grounding.reportHash='Changed',s=>s.tasks[0].status='completed',s=>s.tasks[0].acceptedAt='now']){const s=state();change(s);assert.throws(()=>unchanged(hash,s,'t'));}
});
