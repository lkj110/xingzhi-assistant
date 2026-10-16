// Recheck saved real-model results with final source, without another model call.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'artifacts/engagement/subscription');
const data=JSON.parse(fs.readFileSync(path.join(dir,'pre-restore-state.json'),'utf8'));
const a={data},acceptance=require('../desktop/acceptance.cjs'),attention=require('../desktop/attention.cjs');
const job=data.delegations.find(j=>j.status==='completed'),task=data.tasks.find(t=>t.agentJobId===job.id);
assert.equal(task.status,'completed');assert.deepEqual(acceptance.reasons(a,task,{completed:true}),[]);
const row=attention.snapshot(a).items.find(r=>r.id===`completion:job:${job.id}`);assert.ok(row);
const report=require('../desktop/briefing.cjs').snapshot(a,{projectId:job.projectId,range:'24h'});assert.equal(report.counts.completions,1);assert.equal(report.counts.deliveries,1);
const actual=JSON.parse(fs.readFileSync(path.join(dir,'qinghe-result.json'),'utf8'));assert.deepEqual(actual,{project:'青禾',date:'2026-10-22',budget:6800,owner:'林悦'});
const result={passed:true,modelCalls:0,checks:['最终代码认可真实模型完成任务的当前依据','真实委托完成记录进入关注中心','真实模型交付准确且工作简报计数一致'],at:new Date().toISOString()};
fs.writeFileSync(path.join(dir,'final-code-evidence-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
