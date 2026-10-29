'use strict';
// Complete initial input allowlist; no gold, workflow, lane, budget or identifiers.
function project(spec){const result={title:spec.title,description:'本例为合成历史业务场景，仅按所附资料给定时点判断，不推断其后的实际状态。\n'+spec.description,criteria:spec.criteria,sources:spec.sources.map(source=>({title:source.title,content:source.content}))};if(spec.lane==='fixed_invalid')result.candidate=spec.candidate;return result;}
module.exports={project};
