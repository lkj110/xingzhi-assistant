'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {run,validateOutput}=require('../scripts/foundation-acceptance-offline.cjs');
// Use actual App and backend; deterministic fixtures never launch a model.
for(const mode of ['normal','before-commit-failure','projection-failure','refresh-failure']){
 test(`acceptance UI acknowledgement, durable event and restart: ${mode}`,{timeout:90000},()=>run({mode}));
}
test('offline diagnostic output requires a new absolute path outside the input workspace',t=>{
 const tempRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(tempRoot,'xingzhi-acceptance-output-'));
 t.after(()=>{const relative=path.relative(tempRoot,fs.realpathSync(directory));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(directory,{recursive:true,force:true});});
 const workspace=path.join(directory,'source');fs.mkdirSync(workspace);const original=path.join(workspace,'workspace.json');fs.writeFileSync(original,'sealed');
 assert.throws(()=>validateOutput('relative.json',workspace),/absolute/);
 assert.throws(()=>validateOutput(original,workspace),/new file/);
 assert.throws(()=>validateOutput(path.join(workspace,'new.json'),workspace),/outside/);
 const allowed=path.join(directory,'new-report.json');assert.equal(validateOutput(allowed,workspace),allowed);
 const alias=path.join(directory,'source-alias');fs.symlinkSync(workspace,alias,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>validateOutput(path.join(alias,'new.json'),workspace),/outside/);
 assert.equal(fs.readFileSync(original,'utf8'),'sealed');
});
