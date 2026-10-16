const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolve}=require('../desktop/lineage-scope.cjs');

const rootIds=['700000101','700000102','700000103','700000104','700000105','700000106'];
const scopeText=`SG 六入口交接：当前范围与验收标准

区域 SG，六个入口：
700000101 → demo_analytics.task_node_detail
700000102 → demo_analytics.asset_summary
700000103 → demo_private.event_detail_backup
700000104 → demo_private.event_detail
700000105 → demo_analytics.source_events
700000106 → demo_analytics.review_events

1. 分别从六个入口递归全部上游和全部下游；不横向扩散。
2. 查询记录 999999999 不构成新的入口。`;
const contract=text=>({executionContract:{text,revision:'contract-v2'},goal:'入口任务 IDs: 999'});
function closed(job,status,reason){
 const value=resolve(job);
 assert.equal(value.status,status);
 assert.deepEqual(value.rootIds,[]);
 assert.equal(value.region,'sg');
 assert.equal(typeof value.revision,'string');
 if(reason)assert.equal(value.reason,reason);
 return value;
}

test('the synthetic six-entry SG contract resolves without harvesting narrative IDs',()=>{
 assert.deepEqual(resolve(contract(scopeText)),{status:'ready',rootIds,region:'sg',revision:'contract-v2'});
});

test('literal escaped newlines and CRLF preserve the six-entry contract',()=>{
 for(const text of [scopeText.replace(/\n/g,'\\n'),scopeText.replace(/\n/g,'\r\n'),scopeText.replace(/\n/g,'\\r\\n')]){
  assert.deepEqual(resolve(contract(text)).rootIds,rootIds);
  assert.equal(resolve(contract(text)).status,'ready');
 }
});

test('an existing empty or malformed current contract never falls back to the old goal',()=>{
 for(const executionContract of [{},{text:''},{text:' \n '},{text:null},{text:42},{text:[]},'invalid']){
  closed({executionContract,goal:'入口任务 IDs: 999'},'unavailable','current_contract_text_missing');
 }
 closed(contract('范围已更新；已查询任务123。'),'unavailable','explicit_entry_scope_missing');
});

test('legacy goal is eligible only without a current contract',()=>{
 for(const job of [{goal:'入口任务 IDs: 1, 2、3'},{executionContract:null,goal:'入口任务 IDs: 1, 2、3'}]){
  assert.deepEqual(resolve(job).rootIds,['1','2','3']);
  assert.equal(resolve(job).status,'ready');
 }
 closed(undefined,'unavailable');
 closed({goal:'旧查询 1、2、3',sourceIds:['7'],feedback:[{text:'入口任务 IDs: 9'}]},'unavailable');
});

test('explicit inline IDs validate all tokens, separators and declared counts',()=>{
 for(const text of ['三个入口任务 IDs: 1, 2、3','入口任务IDs：1 / 2 3','root IDs: 1，2，3']){
  assert.deepEqual(resolve(contract(text)).rootIds,['1','2','3']);
 }
 for(const text of ['入口任务 IDs: 1,2,','入口任务 IDs: 1,,2','入口任务 IDs: 1,bad,2','入口任务 IDs: 1,2 # note','入口: 1,2']){
  closed(contract(text),'ambiguous');
 }
 closed(contract('三个入口任务 IDs: 1,2'),'ambiguous','entry_count_mismatch');
 closed(contract('入口任务 IDs: 1\n2'),'ambiguous','entry_ids_line_has_continuation');
 closed(contract('入口任务 IDs: 1\n\n2'),'ambiguous','entry_ids_line_has_continuation');
});

test('table-entry blocks accept explicit Markdown rows and common arrow forms',()=>{
 const text='## 区域 sg，两个入口：\n\n- `001` -> `db`.`a`\n\n* 2 => `db.b`\n\n输出任务：\n9 → db.output';
 assert.deepEqual(resolve(contract(text)).rootIds,['1','2']);
 assert.equal(resolve(contract(text)).status,'ready');
});

test('declared counts are checked rather than treating any parsed prefix as complete',()=>{
 for(const count of ['六','6','二','两'])closed(contract(`${count}个入口：\n1 → db.a`),'ambiguous','entry_count_mismatch');
 for(const count of ['十','10','十二','12','二十一','21','一百零二','102']){
  const n={十:10,十二:12,二十一:21,一百零二:102}[count]||Number(count);
  const text=`${count}个入口：\n`+Array.from({length:n},(_,i)=>`${i+1} → db.t${i}`).join('\n');
  assert.equal(resolve(contract(text)).status,'ready',count);
 }
 for(const count of ['零','0','二三','一十十','1二'])closed(contract(`${count}个入口：\n1 → db.a`),'ambiguous','invalid_declared_count');
});

test('invalid first, middle and final rows invalidate the whole block',()=>{
 for(const row of ['2 → db.b（说明）','2 → missing_table_qualifier','bad → db.b','- missing ID','0 → db.b','9007199254740992 → db.b']){
  for(const text of [`入口：\n${row}\n1 → db.a`,`入口：\n1 → db.a\n${row}\n3 → db.c`,`入口：\n1 → db.a\n\n${row}`]){
   closed(contract(text),'ambiguous');
  }
 }
 closed(contract('入口：\n1 → db.a\nmalformed row\n2 → db.b'),'ambiguous','incomplete_entry_block');
 closed(contract('入口：\n1 → db.a\n\nmalformed row\n2 → db.b'),'ambiguous','incomplete_entry_block');
 closed(contract('入口：\n\n说明'),'ambiguous','invalid_entry_row');
 closed(contract('入口：\n'),'ambiguous','empty_entry_block');
});

test('duplicates cannot manufacture a declared complete scope',()=>{
 closed(contract('两个入口：\n1 → db.a\n1 → db.b'),'ambiguous','duplicate_entry_id');
 closed(contract('入口任务 IDs: 1, 001'),'ambiguous','duplicate_entry_id');
 for(const text of ['入口任务 IDs: 0','入口任务 IDs: 9007199254740992'])closed(contract(text),'ambiguous','invalid_entry_id');
});

test('multiple entry blocks, including historical references, fail closed',()=>{
 for(const text of [
  '入口任务 IDs: 1\n\n已取消的旧范围，仅供历史参考：\n入口任务 IDs: 999',
  '入口：\n1 → db.a\n\n入口：\n1 → db.a',
  '入口任务 IDs: 1\n\n示例：\n```text\n入口任务 IDs: 999\n```',
  '入口任务 IDs: 1\n\n> 入口任务 IDs: 999'
 ])closed(contract(text),'ambiguous','multiple_entry_blocks');
});

test('a reference-only block is not authorized as the current scope',()=>{
 for(const text of ['历史范围：\n入口任务 IDs: 999','```text\n入口任务 IDs: 999\n```','> 入口任务 IDs: 999']){
  closed(contract(text),'ambiguous','entry_block_is_reference');
 }
});

test('explicit non-SG regions are never relabelled as SG',()=>{
 for(const text of ['区域 VA，入口：\n1 → db.a','区域：ttp\n入口任务 IDs: 1']){
  closed(contract(text),'unavailable','entry_region_is_not_sg');
 }
});

test('resolution is deterministic, binds revision and does not mutate frozen inputs',()=>{
 const job=Object.freeze({executionContract:Object.freeze({text:scopeText,revision:'r2'}),goal:'入口任务 IDs: 999'});
 const before=JSON.stringify(job),first=resolve(job);
 assert.deepEqual(resolve(job),first);
 assert.equal(JSON.stringify(job),before);
 assert.equal(first.revision,'r2');
 const legacy={goal:'入口任务 IDs: 1'};
 assert.equal(resolve(legacy).revision,resolve(legacy).revision);
 assert.notEqual(resolve(legacy).revision,resolve({goal:'入口任务 IDs: 2'}).revision);
 assert.notEqual(resolve(legacy).revision,resolve({executionContract:{text:legacy.goal}}).revision);
 first.rootIds.push('999');
 assert.deepEqual(resolve(job).rootIds,rootIds);
});
