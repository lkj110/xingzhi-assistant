'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),search=require('../desktop/evidence-search.cjs'),generation=require('../desktop/generation-context.cjs');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-search-'));t.after(()=>{assert.ok(dir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dir,{recursive:true,force:true});});const a=new Assistant({dir});a.data.settings.evidenceGrounding=true;a.addSources([{title:'人事管理',content:'# 办公地点\n\n员工可在住所处理日常事务。\n\n例外：涉密岗位必须到公司，不能远程工作。\n\n# 食堂\n\n午饭供应面条。'},{title:'差旅',content:'可乘坐公共交通。'}]);const source=a.data.sources.find(s=>s.title==='人事管理');const task=a.createTask({title:'办公安排',description:'明确员工能否居家办公及例外。',criteria:'保留限制条件',sourceIds:[source.id],generationMode:'single',steps:[{title:'撰写',kind:'draft'}]});return {a,task,source};}
test('local multilingual encoder ranks synonym over irrelevant text',async()=>{const e=require('../desktop/evidence-encoder.cjs'),v=await e.encode(['员工可以在家办公','允许远程工作','这是一份烹饪配方']);const dot=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0);assert.ok(dot(v[0],v[1])>dot(v[0],v[2])+0.2);assert.equal(e.status().localOnly,true);assert.equal(e.status().ready,true);});
test('hybrid retrieval reads full rule and exception group through canonical resolver',async t=>{const f=setup(t),request={tool:'search_evidence',query:'在家上班的规定',limit:1};const r=await search.search(f.a,f.task,request);assert.equal(r.degraded,false);assert.equal(r.groups[0].sourceId,f.source.id);assert.equal(r.groups[0].state,'located_not_read');assert.equal(f.task.generationReads,undefined);const batch=await search.readRequests(f.a,f.task,[request],generation.readBatch);const body=batch.rows.map(r=>r.result.content).join('\n');assert.match(body,/住所/);assert.match(body,/涉密/);assert.ok(batch.pageRows.every(r=>r.canonicalProof));assert.equal(batch.searches[0].groups[0].state,'read_pending_model_visibility');});
test('foreign source cannot reveal title, hit counts or cached content',async t=>{const f=setup(t),foreign=f.a.data.sources.find(s=>s.id!==f.source.id);await assert.rejects(search.search(f.a,f.task,{tool:'search_evidence',sourceId:foreign.id,query:'公共交通'}),{code:'CONTEXT_SCOPE_DENIED'});});
test('permissions changed during asynchronous indexing prevent results',async t=>{const f=setup(t),e=require('../desktop/evidence-encoder.cjs');t.mock.method(e,'encode',async texts=>{f.a.contextAccessCheck=()=>({allowed:false,decision:'deny',revision:2});return texts.map(()=>[1,0]);});await assert.rejects(search.search(f.a,f.task,{tool:'search_evidence',query:'办公'}),{code:'CONTEXT_VERSION_CHANGED'});});
test('encoder failure is explicit lexical degradation, never semantic pass',async t=>{const f=setup(t);t.mock.method(require('../desktop/evidence-encoder.cjs'),'encode',async()=>{throw Error('unavailable');});const r=await search.search(f.a,f.task,{tool:'search_evidence',query:'涉密'});assert.equal(r.degraded,true);assert.equal(r.mode,'lexical_fallback');});
test('evidence groups retain far footnotes and table headers',()=>{const segments=[{text:'name,value,unit'},{text:'irrelevant'},{text:'unrelated'},{text:'A,12,kg [脚注7]'},{text:'more'},{text:'[脚注7] 仅供测试',footnoteId:'7'}];assert.deepEqual(search.structure(segments,3).members,[0,2,3,4,5]);});
test('long paragraphs and DOCX table parts retain the complete original group',()=>{const paragraph=Array.from({length:5},(_,i)=>({paragraph:1,text:i?'正文':'仅限境内正式员工'}));assert.deepEqual(search.structure(paragraph,3).members,[0,1,2,3,4]);const table=Array.from({length:4},(_,i)=>({groupId:'table1',partOffset:i*6000,structure:'table',headerRows:[0],text:i?'12\t数值':'金额（万元）\t类别'}));assert.deepEqual(search.structure(table,3).members,[0,1,2,3]);});
test('references in expanded conditions follow a bounded transitive closure',()=>{const rows=Array.from({length:9},(_,i)=>({paragraph:i<5?1:i,text:i===0?'适用范围见[脚注7]':'中间文本'}));rows[8]={text:'[脚注7] 仅正式员工，另见[^extra]',footnoteId:'7'};rows.push({text:'[^extra]: 境外除外'});const group=search.structure(rows,3);assert.ok(group.members.includes(8));assert.ok(group.members.includes(9));assert.equal(group.structureComplete,true);rows.pop();const missing=search.structure(rows,3);assert.equal(missing.structureComplete,false);assert.deepEqual(missing.unresolvedReferences,['note:extra']);});
test('section references include body and nested conditions until the next peer heading',()=>{const rows=['参见2.1','引言','无关','## 2.1 适用范围','仅限境内正式员工，境外无资格','### 2.1.1 附加要求','另见[^limit]','## 2.2 其他','无关正文','[^limit]: 须工作满一年'].map(text=>({text}));const g=search.structure(rows,0);for(const i of [3,4,5,6,9])assert.ok(g.members.includes(i));assert.ok(!g.members.includes(8));assert.equal(g.structureComplete,true);});
test('actual supplied group recovers trimmed conditions instead of reusing disk completeness',()=>{const input={hybridSearch:[{groups:[{sourceId:'s',version:'v',members:[0,1],memberSizes:[{index:0,characters:20},{index:1,characters:8}],state:'read_pending_model_visibility',readRequests:[]}]}],contextReads:[{result:{sourceId:'s',version:'v',segmentIndex:1,start:0,content:'abcdefgh'}}]};const result=search.suppliedGroups(input);assert.equal(result.hybridSearch[0].groups[0].state,'partial');assert.deepEqual(result.hybridSearch[0].groups[0].readRequests,[{tool:'read_segment',sourceId:'s',version:'v',index:0,start:0}]);});
test('DOCX multi-paragraph cell and footnote never concatenate independent numbers',async()=>{const zip=new(require('jszip'))(),p=value=>`<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc>${p('1')}${p('2')}</w:tc><w:tc>${p('kg')}</w:tc></w:tr></w:tbl></w:body></w:document>`);zip.file('word/footnotes.xml',`<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="3">${p('3')}${p('4')}</w:footnote></w:footnotes>`);const result=await require('../desktop/document-structure.cjs').docx(await zip.generateAsync({type:'nodebuffer'}));assert.equal(result.segments[0].text,'1\n2\tkg');assert.equal(result.segments[1].text,'[脚注3] 3\n4');});
test('small source prefill is complete and permission-bound',t=>{const f=setup(t),v=generation.prepare(f.a,f.task,f.a.context(f.task));assert.ok(v.requestedSections.some(r=>r.sourceId===f.source.id&&r.complete));assert.ok(v.requestedSections.every(r=>r.sourceId===f.source.id));});
test('evidence plans cannot self-certify foreign or unknown evidence',t=>{const f=setup(t),id=require('../desktop/grounding.cjs').requirements(f.a,f.task)[0].id;const p=search.plan(f.a,f.task,[{requirementId:id,question:'办公地点',evidenceIds:['forged'],readRequests:[],gap:'尚未读取'}]);assert.deepEqual(p[0].evidenceIds,[]);assert.equal(p[0].state,'gap');assert.throws(()=>search.plan(f.a,f.task,[{requirementId:'fake'}]),{code:'CONTEXT_INVALID_REQUEST'});});
test('CSV raw parsing preserves quoted newlines across chunks',async()=>{const text='name,note\r\n"A","line1\nline2"\r\n'+('B,'+'x'.repeat(6001));const parsed=await require('../desktop/documents.cjs').parse('data.csv',Buffer.from(text));assert.equal(parsed.segments.map(s=>s.text).join(''),text);});
test('DOCX tables and referenced footnotes retain original anchors',async()=>{const zip=new(require('jszip'))();zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>规则</w:t><w:footnoteReference w:id="5"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');zip.file('word/footnotes.xml','<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="5"><w:p><w:r><w:t>仅境内适用</w:t></w:r></w:p></w:footnote></w:footnotes>');const parsed=await require('../desktop/documents.cjs').parse('a.docx',await zip.generateAsync({type:'nodebuffer'}));assert.match(parsed.content,/规则\[脚注5\]/);assert.match(parsed.content,/金额\t12/);assert.ok(parsed.segments.some(s=>s.footnoteId==='5'));});

test('completed evidence-plan reads are not repeated by a later partial plan update',async t=>{
 const {a,task,source}=setup(t);a.contextOptimizationOverrides={A:false,C:false};
 const requirements=require('../desktop/grounding.cjs').requirements(a,task);assert.ok(requirements.length>=2);
 const planned=(requirementId,readRequests)=>({requirementId,question:'核对办公规则',evidenceIds:[],readRequests,gap:''});
 let calls=0;
 a.call=async()=>{
  calls++;
  if(calls===1)return {kind:'artifact',content:'待核对',evidencePlan:[planned(requirements[0].id,[{tool:'read_source',sourceId:source.id}])]};
  assert.equal(calls,2,'a completed read must not force another model call');
  assert.deepEqual(task.evidencePlan.find(row=>row.requirementId===requirements[0].id).readRequests,[]);
  return {kind:'artifact',content:'完成',evidencePlan:[planned(requirements[1].id,[])]};
 };
 const result=await generation.call(a,task,'按资料完成要求',a.context(task),'execute');
 assert.equal(result.content,'完成');assert.equal(calls,2);
 assert.ok(task.generationReads.some(row=>row.result.sourceId===source.id&&row.result.ok));
 assert.deepEqual(task.evidencePlan.flatMap(row=>row.readRequests),[]);
});

test('successful computed evidence consumes only its matching planned request',async t=>{
 const {a,task,source}=setup(t),tool=require('../desktop/tool-evidence.cjs');
 const request={tool:'compute_evidence',operation:'count',inputs:[{sourceId:source.id,whole:true}],args:{format:'csv'}};
 const other={...request,args:{format:'json'}};
 const batch=await tool.readRequests(a,task,[request],requests=>generation.readBatch(a,task,requests));
 assert.equal(batch.rows[0].result.computedEvidence.output.unit,'rows');
 const consumed=search.consumePlan([{readRequests:[request],gap:''},{readRequests:[other],gap:''}],batch);
 assert.deepEqual(consumed[0].readRequests,[]);assert.equal(consumed[0].state,'read_not_verified');
 assert.deepEqual(consumed[1].readRequests,[other]);assert.equal(consumed[1].state,'unread');
});

test('partial evidence-plan reads resume at the next page without losing their target',t=>{
 const {a,task,source}=setup(t),request={tool:'read_segment',sourceId:source.id,index:0};
 const partial=generation.readBatch(a,task,[request],{maxChars:2});
 assert.equal(partial.rows[0].result.complete,false);assert.equal(partial.rows[0].result.next,2);
 const continued=search.consumePlan([{readRequests:[request],gap:''}],partial)[0];
 assert.deepEqual(continued.readRequests,[{...request,start:2,version:partial.rows[0].result.version}]);
 const suffix=generation.readBatch(a,task,continued.readRequests);
 assert.equal(partial.rows[0].result.content+suffix.rows[0].result.content,generation.readBatch(a,task,[request]).rows[0].result.content);
 assert.deepEqual(search.consumePlan([continued],suffix)[0].readRequests,[]);
 const atomic={tool:'read_source',sourceId:source.id},pending=generation.readBatch(a,task,[atomic],{maxChars:1});
 assert.equal(pending.rows[0].result.pending,true);
 const retained=search.consumePlan([{readRequests:[atomic],gap:''}],pending)[0].readRequests[0];
 assert.equal(retained.sourceId,source.id);assert.equal(retained.start,0);assert.ok(retained.version);
 assert.deepEqual(search.consumePlan([{readRequests:[request],gap:''}],{...partial,next:[]})[0].readRequests,[request]);
});
