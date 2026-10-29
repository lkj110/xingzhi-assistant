'use strict';
const assert=require('node:assert/strict'),{sha}=require('./identity.cjs'),{current}=require('../foundation-marker-runner/phases.cjs');
function content(data,id){const {task,draft}=current(data,id);return sha(JSON.stringify({title:task.title,description:task.description,criteria:task.criteria,sourceIds:task.sourceIds,primaryArtifactId:task.primaryArtifactId,draft:{id:draft.id,title:draft.title,content:draft.content},sources:task.sourceIds.map(id=>{const s=data.sources.find(s=>s.id===id);assert.ok(s,'Source disappeared');return {id:s.id,title:s.title,content:s.content};})}));}
function checkpoint(data,id){const {task}=current(data,id);assert.equal(task.acceptedAt,undefined,'Premature acceptance');return sha(JSON.stringify({content:content(data,id),status:task.status,grounding:task.grounding,verification:task.verification}));}
function unchanged(expected,data,id,kind='content'){assert.equal((kind==='checkpoint'?checkpoint:content)(data,id),expected,'Content, requirements, source or checkpoint changed during review');}
module.exports={content,checkpoint,unchanged};
