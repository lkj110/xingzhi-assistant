const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
test('deleting a source also isolates cached action bodies when the original row no longer exists',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'public-context-v3-'));const a=new Assistant({dir});
 t.after(()=>{require('../desktop/deadline-scheduler.cjs').dispose(a);a.streamController?.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 await a.dispatch('import',{items:[{title:'temporary source',content:'source-body-must-not-survive-delete'}]});
 const s=a.data.sources[0];a.data.agentActions.push({id:'historical-action',tool:'lark_update',status:'done',content:s.content,args:{},result:{sourceId:s.id,url:'https://example.invalid/docx/original'}});
 assert.equal(a.publicState().agentActions[0].content,s.content);
 await a.dispatch('deleteSource',{id:s.id});
 const result=a.publicState();assert.equal(result.sources.length,0);assert.equal(result.agentActions[0].content,'');
 assert.equal(result.agentActions[0].result.url,'https://example.invalid/docx/original');
});
