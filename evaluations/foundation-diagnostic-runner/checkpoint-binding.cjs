'use strict';
const assert=require('node:assert/strict'),{sha}=require('./identity.cjs');
const {current,assertReady}=require('../foundation-marker-runner/phases.cjs');
function binding(data,id){const {task}=current(data,id);assertReady(task);return sha(JSON.stringify({title:task.title,description:task.description,criteria:task.criteria,sourceIds:task.sourceIds,steps:task.steps,primaryArtifactId:task.primaryArtifactId,grounding:task.grounding,verification:task.verification,sources:data.sources,artifacts:data.artifacts}));}
function unchanged(expected,data,id){assert.equal(binding(data,id),expected,'Gate content or evidence changed during independent review');}
module.exports={binding,unchanged};
