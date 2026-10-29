'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),b=require('./binding.cjs');
const state=()=>({tasks:[{id:'t',status:'waiting',primaryArtifactId:'a',title:'Task',description:'Input',criteria:'Criterion',sourceIds:['s'],steps:[{artifactId:'a'}],grounding:{passed:false,reportHash:'r'},verification:{passed:false}}],artifacts:[{id:'a',title:'Draft',content:'Fact'}],sources:[{id:'s',title:'Source',content:'Fact'}]});
test('checkpoint binds marker/blocked state, requirements, original source and report',()=>{
 const original=state(),hash=b.checkpoint(original,'t');b.unchanged(hash,original,'t','checkpoint');
 for(const change of [s=>s.artifacts[0].content='Changed',s=>s.tasks[0].criteria='Changed',s=>s.sources[0].content='Changed',s=>s.tasks[0].grounding.reportHash='Changed',s=>s.tasks[0].status='completed',s=>s.tasks[0].acceptedAt='now']){const s=state();change(s);assert.throws(()=>b.unchanged(hash,s,'t','checkpoint'));}
});
test('human recheck/accept may update state and report but not content or requirements',()=>{
 const original=state(),hash=b.content(original,'t'),next=state();next.tasks[0].status='completed';next.tasks[0].grounding={passed:true,reportHash:'new'};next.tasks[0].acceptedAt='now';b.unchanged(hash,next,'t');
 for(const change of [s=>s.tasks[0].criteria='Changed',s=>s.tasks[0].title='Changed',s=>s.sources[0].content='Changed',s=>s.sources[0].title='Changed',s=>s.artifacts[0].content='Changed']){const s=state();change(s);assert.throws(()=>b.unchanged(hash,s,'t'));}
});
