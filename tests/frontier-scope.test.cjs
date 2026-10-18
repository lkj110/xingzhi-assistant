const {test}=require('node:test'),assert=require('node:assert/strict');
const obligations=require('../desktop/work-obligations.cjs');
function fixture(){
 const sources=[],job={id:'job',dataPlatform:'sg-readonly',sourceIds:[],executionContract:{text:'区域 SG，两个入口：\n1 → db.first\n2 → db.second\n\n不得横向扩展。'},executionState:{operations:{}}},a={data:{sources}};
 const add=(op,taskId,ids)=>{const id='source-'+sources.length,values=ids.map(id=>({projectId:7,...(typeof id==='object'?id:{id})}));sources.push({id,platformSnapshot:true,content:JSON.stringify({operation:op,query:{op,taskId,depth:1},data:{nodes:values.map(row=>({...row,parentRelation:row.parentRelation||(op==='upstream'?(row.id===taskId?values.filter(r=>r.id!==taskId).map(r=>({id:r.id,...(r.region?{region:r.region}:{})})):[]):(row.id===taskId?[]:[{id:taskId}]))}))}})});job.sourceIds.push(id);return sources.at(-1);};
 return {a,job,add};
}
test('only explicitly labelled current user entry lists seed deterministic traversal',()=>{
 assert.deepEqual(obligations.lineageRoots({executionContract:{text:'区域 SG，两个入口：\\n101 → db.a\\n102 → db.b\\n\\n例外999999999'},goal:'入口任务 IDs: 999'}),['101','102']);
 assert.deepEqual(obligations.lineageRoots({executionContract:{text:'范围已改，参见任务123'},goal:'入口任务 IDs: 999'}),[]);
 assert.deepEqual(obligations.lineageRoots({goal:'入口任务 IDs: 1, 2、3'}),['1','2','3']);
 assert.deepEqual(obligations.lineageRoots({goal:'已查询1、2；其他任务3'}),[]);
 assert.deepEqual(obligations.lineageRoots({goal:'入口：\n1 → db.a\n\n输出任务：\n9 → db.z'}),['1']);
});
test('directional reachability excludes old unrelated queries and upstreams of downstream side inputs',()=>{
 const f=fixture();f.add('upstream',1,[1,3]);f.add('upstream',3,[3,4]);f.add('upstream',4,[4,1]);
 f.add('downstream',1,[1,5]);f.add('downstream',5,[5,6]);f.add('upstream',5,[5,90]);f.add('upstream',90,[90,91]);f.add('upstream',800,[800,801]);
 const rows=obligations.frontier(f.a,f.job),ids=direction=>rows.filter(r=>r.direction===direction).map(r=>r.nodeId).sort();
 // 1 -> 4 -> 3 -> 1 is a real cycle: all three are reachable in both
 // directions without switching direction. The side input 90 still is not.
 assert.deepEqual(ids('upstream'),['1','2','3','4']);assert.deepEqual(ids('downstream'),['1','2','3','4','5','6']);assert.ok(rows.filter(r=>r.nodeId!=='2').every(r=>r.scopeProven));
 assert.ok(rows.filter(r=>r.nodeId==='2').every(r=>r.status==='scope_unresolved'&&r.query===null),'the untouched second root has no evidenced project to dispatch');
 assert.equal(rows.find(r=>r.nodeId==='6').status,'unexpanded');assert.equal(rows.length,new Set(rows.map(r=>r.direction+':'+r.nodeId)).size);
});
test('scope changes exclude old roots, source removal drops their unproven descendants',()=>{
 const f=fixture();f.add('downstream',1,[1,3]);f.add('downstream',3,[3,4]);f.add('downstream',8,[8,9]);
 f.job.executionContract.text='入口任务 IDs: 8';assert.deepEqual(obligations.frontier(f.a,f.job).filter(r=>r.direction==='downstream').map(r=>r.nodeId),['8','9']);
 f.job.executionContract.text='入口任务 IDs: 1';f.a.data.sources[0].deleted=true;
 assert.deepEqual(obligations.frontier(f.a,f.job).filter(r=>r.direction==='downstream').map(r=>r.nodeId),['1']);
});
test('cross-region historical queries cannot extend automatic SG traversal',()=>{
 const f=fixture();f.add('downstream',1,[1,{id:3,crossRegion:true}]);f.add('downstream',3,[{id:3,crossRegion:true},4]);
 const rows=obligations.frontier(f.a,f.job);assert.ok(rows.some(r=>r.nodeId==='3'));assert.ok(!rows.some(r=>r.nodeId==='4'));
});
test('unscoped legacy inventory remains visible but is not proof of an authorized root',()=>{
 const f=fixture();f.job.executionContract.text='继续原调查';f.add('upstream',1,[1,3]);
 const rows=obligations.frontier(f.a,f.job);assert.equal(rows.length,2);assert.ok(rows.every(r=>r.scopeProven===false));assert.match(rows.find(r=>r.nodeId==='3').note,/不自动扩张/);
});
test('region-only cross-border nodes retain distinct identity and cannot trigger SG expansion',()=>{
 const f=fixture();f.add('upstream',1,[1,{id:3,region:'ttp'}]);f.add('upstream',3,[{id:3,region:'ttp'},4]);f.add('downstream',2,[2,{id:3,region:'sg'}]);
 const rows=obligations.frontier(f.a,f.job),cross=rows.find(r=>r.nodeId==='3'&&r.region==='ttp');
 assert.equal(cross.status,'cross_region');assert.ok(!rows.some(r=>r.nodeId==='4'));
 assert.equal(rows.find(r=>r.nodeId==='3'&&r.region==='sg').status,'unexpanded');
});
test('older shallow snapshots cannot erase newer deep relationships or their path receipts',()=>{
 const f=fixture();f.add('downstream',1,[{id:1,parentRelation:[]},{id:3,parentRelation:[{id:1}]},{id:4,parentRelation:[{id:3}]}]);f.add('downstream',1,[1,3]);
 const rows=obligations.frontier(f.a,f.job),leaf=rows.find(r=>r.nodeId==='4');assert.ok(leaf);assert.equal(leaf.rootId,'1');assert.deepEqual(leaf.path.map(n=>n.nodeId),['1','3','4']);assert.ok(leaf.proofSourceIds.includes('source-0'));
 f.a.data.sources.reverse();const reversed=obligations.frontier(f.a,f.job);assert.deepEqual(reversed.map(r=>r.direction+':'+r.nodeId).sort(),rows.map(r=>r.direction+':'+r.nodeId).sort());
});
test('disconnected response members are not proven paths; superseded edges are not revived',()=>{
 const f=fixture();const old=f.add('upstream',1,[1,3,{id:9,parentRelation:[]}]);
 const snap=JSON.parse(old.content);snap.data.nodes.find(n=>n.id===1).parentRelation=[{id:3}];old.content=JSON.stringify(snap);
 assert.ok(!obligations.frontier(f.a,f.job).some(r=>r.nodeId==='9'));
 const replacement=f.add('upstream',1,[1]);replacement.previousSourceId=old.id;
 assert.ok(!obligations.frontier(f.a,f.job).some(r=>r.nodeId==='3'));
});
test('contradictory regional metadata remains unresolved rather than authorizing SG expansion',()=>{
 for(const metadata of [{region:'sg',crossRegion:true},{region:'sg',location:'ttp'}]){
  const f=fixture();f.add('downstream',1,[1,{id:3,...metadata}]);
  const rows=obligations.frontier(f.a,f.job),boundary=rows.find(r=>r.nodeId==='3');
  assert.equal(boundary.region,'unknown');assert.equal(boundary.status,'scope_unresolved');assert.equal(boundary.scopeProven,false);
 }
});
test('contradictory source regions and mismatched response roots provide no path proof',()=>{
 for(const alter of [snap=>{snap.region='sg';snap.data.region='ttp';},snap=>{snap.region='sg';snap.query.region='ttp';},snap=>{snap.data.root={id:99};},snap=>{snap.data.taskId=99;}]){
  const f=fixture(),source=f.add('upstream',1,[1,3]),snap=JSON.parse(source.content);alter(snap);source.content=JSON.stringify(snap);
  const rows=obligations.frontier(f.a,f.job);assert.ok(!rows.some(r=>r.nodeId==='3'));assert.equal(rows.find(r=>r.nodeId==='1'&&r.direction==='upstream').status,'scope_unresolved');
 }
});
