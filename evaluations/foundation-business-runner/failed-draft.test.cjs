'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{capture}=require('./failed-draft.cjs'),{digest}=require('../foundation-marker-runner/phases.cjs');
const state=()=>({tasks:[{id:'t',status:'blocked',primaryArtifactId:'a',grounding:{passed:false}}],artifacts:[{id:'a',title:'Draft',content:'Produced text'}]});
test('verification interruption preserves the produced draft without replacing an existing review',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'business-failed-draft-')),args={directory,caseId:'F03-case',stage:'initial',input:{title:'Task'},data:state(),taskId:'t',error:Error('CLI rejected')};assert.equal(capture(args).captured,true);const file=path.join(directory,'F03-case-initial-draft.json'),before=fs.readFileSync(file);assert.equal(JSON.parse(before).technicalInterrupted,true);assert.equal(capture(args).reason,'already-recorded');assert.deepEqual(fs.readFileSync(file),before);
});
test('failed revision with unchanged prior draft never becomes a new revision judgment',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'business-no-revision-')),data=state(),args={directory,caseId:'F05-case',stage:'revision',input:{},data,taskId:'t',error:Error('generation failed'),priorDraftHash:digest(data.artifacts[0])};assert.equal(capture(args).reason,'revision-produced-no-new-draft');assert.equal(fs.readdirSync(directory).length,0);data.artifacts[0].content='Actually revised';assert.equal(capture(args).captured,true);
});
