const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const badges=require('../desktop/pending-badges.cjs'),{Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t,onStateSaved){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-badges-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir,onStateSaved,chat:()=>{throw Error('No inference for badges');}});a.data.providers=[{id:'p',name:'测试',type:'ollama',model:'fixture',baseUrl:'http://localhost:11434'}];a.data.settings.roles={organize:'p',execute:'p',verify:'p'};return a;}
function surface(a,platform='darwin'){
 const calls={titles:[],badges:[],tips:[],trayMenus:[],dockMenus:[],opened:0,categories:[]};
 const app={dock:{setBadge:x=>calls.badges.push(x),setMenu:m=>calls.dockMenus.push(m)}},tray={setTitle:x=>calls.titles.push(x),setToolTip:x=>calls.tips.push(x),setContextMenu:x=>calls.trayMenus.push(x)},Menu={buildFromTemplate:x=>x};
 const c=badges.create({app,tray,Menu,assistant:a,platform,openPending:category=>{calls.opened++;calls.categories.push(category);},showMain(){},openCapture(){},pause(){},quit(){}});
 return {calls,c,app,tray};
}
function question(a){const j=agent.buildJob(a,{goal:'等待用户选择'});j.status='needs_input';a.data.delegations.push(j);a.data.decisions.push({id:'q',jobId:j.id,kind:'question',status:'open',question:'选哪个方案？',taskIds:[],sourceIds:[]});return j;}
test('Count matches actionable cards, not unread or notified records, without double-counting a question and its job',t=>{
 const a=setup(t),j=question(a);assert.equal(badges.count(a.data),1);
 const card=require('../desktop/attention.cjs').snapshot(a).items[0];a.dispatch('attentionRead',{id:card.id,revision:card.revision});assert.equal(badges.count(a.data),1);
 assert.equal(badges.count(a.data),a.publicState().decisionCards.length);
 a.data.decisions[0].status='answered';j.status='ready';assert.equal(badges.count(a.data),0);
});
for(const status of ['blocked','limited','review','needs_input'])test(`${status} requires human intervention and counts once`,t=>{const a=setup(t),j=agent.buildJob(a,{goal:'工作'});j.status=status;a.data.delegations.push(j);assert.equal(badges.count(a.data),1);});
for(const status of ['ready','running','retry','waiting','completed','paused','cancelled'])test(`${status} alone is not a pending human message`,t=>{const a=setup(t),j=agent.buildJob(a,{goal:'工作'});j.status=status;a.data.delegations.push(j);assert.equal(badges.count(a.data),0);});
test('Independent review, blocked and waiting tasks count; deleted work and completed notifications do not',t=>{
 const a=setup(t);for(const status of ['review','blocked','waiting']){const task=a.createTask({title:status});task.status=status;task.waitingOn='等待外部结果';}
 assert.equal(badges.count(a.data),3);a.data.tasks[0].deletedAt=new Date().toISOString();assert.equal(badges.count(a.data),2);
 a.data.tasks.forEach(t=>t.status='completed');assert.equal(badges.count(a.data),0);
});
test('Tray and Dock update together, open the pending list, clear at zero and skip unchanged updates',t=>{
 const a=setup(t),{calls,c}=surface(a);t.after(()=>c.dispose());c.refresh();assert.deepEqual(calls.badges,['']);assert.equal(calls.trayMenus[0][0].enabled,false);
 const j=question(a);c.refresh();assert.equal(calls.titles.at(-1),'推进 1 · 验收 0');assert.equal(calls.badges.at(-1),'1');assert.match(calls.tips.at(-1),/1 项需要你处理/);calls.trayMenus.at(-1)[0].click();calls.dockMenus.at(-1)[0].click();assert.equal(calls.opened,2);
 c.refresh();assert.equal(calls.badges.length,2);a.data.decisions[0].status='answered';j.status='ready';c.refresh();assert.equal(calls.badges.at(-1),'');assert.equal(calls.titles.at(-1),'');assert.equal(c.count(),0);
});
test('Background saves refresh badges promptly and coalesce rapid changes',async t=>{
 let c;const a=setup(t,()=>c?.schedule()),surfaceState=surface(a);c=surfaceState.c;t.after(()=>c.dispose());c.refresh();question(a);a.save();a.save();a.save();await nextTurn();assert.equal(surfaceState.calls.badges.at(-1),'1');assert.equal(surfaceState.calls.badges.length,2);
 a.data.decisions[0].status='answered';a.data.delegations[0].status='ready';a.save();await nextTurn();assert.equal(surfaceState.calls.badges.at(-1),'');
});
test('Restart derives the existing pending count and disposing cancels queued updates',async t=>{
 const a=setup(t);question(a);a.save();const b=new Assistant({dir:a.dir}),{calls,c}=surface(b);c.refresh();assert.deepEqual(calls.badges,['1']);c.schedule();c.dispose();await nextTurn();c.refresh();assert.deepEqual(calls.badges,['1']);
});
test('Native badge failure is retried without failing business work',t=>{
 const a=setup(t),{calls,c,tray}=surface(a);t.after(()=>c.dispose());const original=tray.setTitle;tray.setTitle=()=>{throw Error('Native unavailable');};assert.doesNotThrow(()=>c.refresh());assert.equal(calls.badges.length,0);tray.setTitle=original;c.refresh();assert.deepEqual(calls.badges,['']);
});
test('A successful durable save remains successful if a desktop observer fails; failed save never notifies',t=>{
 let saved=0;const a=setup(t,()=>{saved++;throw Error('UI failed');});const before=saved;a.data.settings.profile='saved';assert.doesNotThrow(()=>a.save());assert.equal(saved,before+1);assert.equal(JSON.parse(fs.readFileSync(a.file)).settings.profile,'saved');a.file=path.join(a.dir,'absent','workspace.json');assert.throws(()=>a.save());assert.equal(saved,before+1);
});
test('Non-macOS keeps the native menu and tooltip without calling macOS APIs',t=>{
 const a=setup(t);question(a);const {c,calls}=surface(a,'linux');t.after(()=>c.dispose());c.refresh();assert.equal(calls.titles.length,0);assert.equal(calls.badges.length,0);assert.match(calls.trayMenus[0][0].label,/1/);
});

test('Separate intervention and review totals include independent tasks and preserve the total',t=>{
 const a=setup(t),j=question(a);const review=agent.buildJob(a,{goal:'待验收'});review.status='review';a.data.delegations.push(review);
 for(const status of ['review','blocked','waiting']){const task=a.createTask({title:status});task.status=status;task.waitingOn='补充结果';}
 assert.deepEqual(badges.counts(a.data),{total:5,progress:3,review:2});
 const cards=a.publicState().decisionCards;assert.equal(cards.filter(d=>d.category==='review').length,2);assert.equal(cards.filter(d=>d.category==='progress').length,3);
 a.data.tasks.find(t=>t.status==='review').deletedAt=new Date().toISOString();assert.deepEqual(badges.counts(a.data),{total:4,progress:3,review:1});
 // An open question on a review task still requires intervention; it is not acceptance.
 const task=a.data.tasks.find(t=>t.status==='blocked');task.status='review';a.data.decisions.push({id:'independent-question',kind:'task_question',status:'open',taskIds:[task.id],sourceIds:[],question:'确认范围'});
 assert.deepEqual(badges.counts(a.data),{total:4,progress:3,review:1});
 a.data.decisions[0].status='answered';j.status='running';assert.deepEqual(badges.counts(a.data),{total:3,progress:2,review:1});
});
test('Changing category at the same total refreshes native title and category menu routes',t=>{
 const a=setup(t),j=question(a),{c,calls}=surface(a);t.after(()=>c.dispose());c.refresh();assert.equal(calls.titles.at(-1),'推进 1 · 验收 0');
 assert.equal(calls.trayMenus.at(-1)[1].enabled,true);assert.equal(calls.trayMenus.at(-1)[2].enabled,false);
 calls.trayMenus.at(-1)[1].click();assert.equal(calls.categories.at(-1),'progress');
 a.data.decisions[0].status='answered';j.status='review';c.refresh();assert.equal(calls.titles.at(-1),'推进 0 · 验收 1');assert.equal(calls.badges.at(-1),'1');assert.equal(calls.badges.length,2);
 assert.equal(calls.trayMenus.at(-1)[1].enabled,false);assert.equal(calls.trayMenus.at(-1)[2].enabled,true);
 calls.trayMenus.at(-1)[2].click();calls.dockMenus.at(-1)[2].click();assert.deepEqual(calls.categories,['progress','review','review']);
 j.status='completed';c.refresh();assert.equal(calls.titles.at(-1),'');assert.equal(calls.badges.at(-1),'');
});
