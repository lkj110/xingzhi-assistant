'use strict';
// Local filesystem regressions only; no CLI discovery, credentials or models.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {capturePaths}=require('./paths.cjs');
const native=target=>fs.realpathSync.native(target);
function fixture(t){
 const temporary=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporary,'foundation-path-test-'));
 const canonicalBase=native(directory);t.after(()=>{const actual=native(directory);assert.equal(actual,canonicalBase);assert.equal(path.dirname(actual),native(temporary));assert.ok(path.basename(actual).startsWith('foundation-path-test-'));fs.rmSync(actual,{recursive:true,force:true});});
 const cwd=path.join(directory,'xingzhi-model-request');fs.mkdirSync(cwd);const schema=path.join(cwd,'schema.json'),output=path.join(cwd,'response.json');fs.writeFileSync(schema,'{"synthetic":true}');
 return {directory,cwd,schema,output,temporaryRoot:directory};
}
const args=f=>({temporaryRoot:f.temporaryRoot,cwd:f.cwd,schema:f.schema,output:f.output});
const reject=(fn,code,stage='path-capture')=>assert.throws(fn,e=>{assert.equal(e.code,'RUNNER_PATH_'+code);assert.equal(e.stage,stage);assert.ok(e.pathDiagnostics);return true;});
function alias(f,spelling){
 const original=fs.realpathSync(os.tmpdir()),canonical=native(os.tmpdir()),map=value=>spelling==='long'?native(path.dirname(value))+path.sep+path.basename(value):value;
 return {...args(f),temporaryRoot:spelling==='long'?native(f.temporaryRoot):f.temporaryRoot,cwd:spelling==='long'?native(f.cwd):f.cwd,schema:map(f.schema),output:map(f.output),different:original.toLowerCase()!==canonical.toLowerCase()};
}
test('ordinary paths bind an absent result, then accept its ordinary creation',t=>{
 const f=fixture(t),bound=capturePaths(args(f));assert.equal(bound.cwd,native(f.cwd));assert.equal(bound.schemaBytes.toString(),'{"synthetic":true}');assert.equal(bound.paths.output.exists,false);assert.doesNotThrow(()=>bound.revalidate({output:'absent'}));assert.doesNotThrow(()=>bound.revalidate({output:'optional'}));
 fs.writeFileSync(f.output,'synthetic result');assert.doesNotThrow(()=>bound.revalidate({output:'required'}));assert.equal(bound.paths.output.exists,true);assert.equal(bound.paths.output.canonical,native(f.output));
});
test('actual Windows short and long aliases work in all parent/cwd/schema/output combinations',t=>{
 const f=fixture(t),short=alias(f,'short'),long=alias(f,'long');if(process.platform!=='win32'||!short.different){t.skip('An actual Windows 8.3 TEMP alias is required');return;}
 for(let mask=0;mask<16;mask++){const input={};for(const [i,name] of ['temporaryRoot','cwd','schema','output'].entries())input[name]=(mask&(1<<i)?long:short)[name];const bound=capturePaths(input);assert.equal(bound.cwd,native(f.cwd));assert.doesNotThrow(()=>bound.revalidate({output:'absent'}));}
});
test('Windows parent case variants resolve to the same directory and file identity',t=>{
 if(process.platform!=='win32'){t.skip('Windows case semantics');return;}const f=fixture(t);const input=Object.fromEntries(Object.entries(args(f)).map(([k,v])=>[k,['schema','output'].includes(k)?path.join(path.dirname(v).toUpperCase(),path.basename(v)):v.toUpperCase()]));const bound=capturePaths(input);assert.doesNotThrow(()=>bound.revalidate({output:'absent'}));fs.writeFileSync(f.output,'result');assert.doesNotThrow(()=>bound.revalidate({output:'required'}));
});
test('missing or relative path values fail with bounded path-only diagnostics',t=>{
 const f=fixture(t);for(const name of ['temporaryRoot','cwd','schema','output'])for(const value of [undefined,'relative',null])reject(()=>capturePaths({...args(f),[name]:value}),'INPUT');
 try{capturePaths({...args(f),cwd:'relative'});}catch(e){for(const row of Object.values(e.pathDiagnostics))assert.deepEqual(Object.keys(row).sort(),['canonical','exists','raw']);assert.equal(e.message.includes('synthetic'),false);}
});
test('sibling prefix lookalike is not a child of the bound temporary root',t=>{
 const f=fixture(t),temporaryRoot=path.join(f.directory,'root'),other=path.join(f.directory,'root-sibling');fs.mkdirSync(temporaryRoot);fs.mkdirSync(other);const cwd=path.join(other,'xingzhi-model-escape');fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'schema.json'),'{}');reject(()=>capturePaths({temporaryRoot,cwd,schema:path.join(cwd,'schema.json'),output:path.join(cwd,'response.json')}),'OUTSIDE');
});
test('cwd outside the supplied root and wrong cwd prefix are rejected',t=>{
 const f=fixture(t);reject(()=>capturePaths({...args(f),temporaryRoot:f.cwd}),'OUTSIDE');const wrong=path.join(f.directory,'unplanned');fs.mkdirSync(wrong);reject(()=>capturePaths({...args(f),cwd:wrong}),'OUTSIDE');
});
test('schema or output parameters cannot select another case or filename',t=>{
 const f=fixture(t),other=path.join(f.directory,'xingzhi-model-other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'schema.json'),'{}');
 for(const name of ['schema','output'])reject(()=>capturePaths({...args(f),[name]:path.join(other,path.basename(f[name]))}),'OUTSIDE');
 for(const [name,bad] of [['schema','alternate.json'],['output','alternate.json']])reject(()=>capturePaths({...args(f),[name]:path.join(f.cwd,bad)}),'NAME');
});
test('initial existing output is refused even if it is an ordinary file',t=>{const f=fixture(t);fs.writeFileSync(f.output,'old');reject(()=>capturePaths(args(f)),'OUTPUT_EXISTS');});
test('schema hard links are refused before any read or dispatch',t=>{const f=fixture(t);fs.linkSync(f.schema,path.join(f.directory,'schema-alias'));reject(()=>capturePaths(args(f)),'LINK');});
test('cwd junction cannot stand in for an actual working directory',t=>{
 const f=fixture(t),link=path.join(f.directory,'xingzhi-model-link');fs.symlinkSync(f.cwd,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>capturePaths({...args(f),cwd:link,schema:path.join(link,'schema.json'),output:path.join(link,'response.json')}),e=>/^RUNNER_PATH_(DIRECTORY|LINK)$/.test(e.code));
});
test('schema junction or directory cannot pass as schema file',t=>{const f=fixture(t);fs.unlinkSync(f.schema);fs.symlinkSync(f.directory,f.schema,process.platform==='win32'?'junction':'dir');reject(()=>capturePaths(args(f)),'LINK');});
test('parent junction into a different case cannot redirect schema or result',t=>{
 const f=fixture(t),other=path.join(f.directory,'xingzhi-model-other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'schema.json'),'{}');const link=path.join(f.cwd,'redirect');fs.symlinkSync(other,link,process.platform==='win32'?'junction':'dir');
 for(const name of ['schema','output'])reject(()=>capturePaths({...args(f),[name]:path.join(link,path.basename(f[name]))}),'OUTSIDE');
});
test('schema content changes are rejected on revalidation',t=>{const f=fixture(t),bound=capturePaths(args(f));fs.writeFileSync(f.schema,'{"changed":true}');reject(()=>bound.revalidate({output:'absent'}),'CHANGED','path-revalidate');});
test('schema replacement with identical contents is rejected by identity',t=>{const f=fixture(t),bound=capturePaths(args(f));fs.renameSync(f.schema,path.join(f.cwd,'old-schema'));fs.writeFileSync(f.schema,'{"synthetic":true}');reject(()=>bound.revalidate({output:'absent'}),'CHANGED','path-revalidate');});
test('cwd replacement is rejected even with an identical new schema',t=>{const f=fixture(t),bound=capturePaths(args(f));fs.renameSync(f.cwd,path.join(f.directory,'old-cwd'));fs.mkdirSync(f.cwd);fs.writeFileSync(f.schema,'{"synthetic":true}');reject(()=>bound.revalidate({output:'absent'}),'CHANGED','path-revalidate');});
test('late schema hard link and missing schema are rejected',t=>{
 const f=fixture(t),bound=capturePaths(args(f));const link=path.join(f.directory,'late-link');fs.linkSync(f.schema,link);reject(()=>bound.revalidate({output:'absent'}),'LINK','path-revalidate');fs.unlinkSync(link);fs.unlinkSync(f.schema);reject(()=>bound.revalidate({output:'absent'}),'UNREADABLE','path-revalidate');
});
test('result appearing before dispatch is rejected',t=>{const f=fixture(t),bound=capturePaths(args(f));fs.writeFileSync(f.output,'premature');reject(()=>bound.revalidate({output:'absent'}),'OUTPUT_EXISTS','path-revalidate');});
test('required result missing remains missing, never treated as empty data',t=>{const f=fixture(t),bound=capturePaths(args(f));reject(()=>bound.revalidate({output:'required'}),'OUTPUT_MISSING','path-revalidate');});
test('created result must not be a hard link or junction',t=>{
 const f=fixture(t),bound=capturePaths(args(f));fs.linkSync(f.schema,f.output);reject(()=>bound.revalidate({output:'required'}),'LINK','path-revalidate');fs.unlinkSync(f.output);fs.symlinkSync(f.directory,f.output,process.platform==='win32'?'junction':'dir');reject(()=>bound.revalidate({output:'required'}),'LINK','path-revalidate');
});
test('result replacement and disappearance after binding are rejected',t=>{
 const f=fixture(t),bound=capturePaths(args(f));fs.writeFileSync(f.output,'original');bound.revalidate({output:'required'});fs.renameSync(f.output,path.join(f.cwd,'old-result'));fs.writeFileSync(f.output,'replacement');reject(()=>bound.revalidate({output:'required'}),'CHANGED','path-revalidate');fs.unlinkSync(f.output);reject(()=>bound.revalidate({output:'optional'}),'CHANGED','path-revalidate');
});
test('real file symlink is refused when supported by Windows host',t=>{
 const f=fixture(t),target=path.join(f.directory,'target.json');fs.writeFileSync(target,'{}');fs.unlinkSync(f.schema);try{fs.symlinkSync(target,f.schema,'file');}catch(e){if(process.platform==='win32'&&e.code==='EPERM'){t.skip('Windows host does not grant file symlink creation');return;}throw e;}reject(()=>capturePaths(args(f)),'LINK');
});

test('temporary root replacement cannot reuse an earlier binding',t=>{
 const f=fixture(t),temporaryRoot=path.join(f.directory,'root');fs.mkdirSync(temporaryRoot);const cwd=path.join(temporaryRoot,'xingzhi-model-root-check');fs.mkdirSync(cwd);const schema=path.join(cwd,'schema.json'),output=path.join(cwd,'response.json');fs.writeFileSync(schema,'{}');const bound=capturePaths({temporaryRoot,cwd,schema,output});fs.renameSync(temporaryRoot,path.join(f.directory,'old-root'));fs.mkdirSync(temporaryRoot);fs.mkdirSync(cwd);fs.writeFileSync(schema,'{}');reject(()=>bound.revalidate({output:'absent'}),'CHANGED','path-revalidate');
});

test('leaf names stay exact even on case-insensitive Windows directories',t=>{const f=fixture(t);for(const name of ['schema','output'])reject(()=>capturePaths({...args(f),[name]:path.join(f.cwd,path.basename(f[name]).toUpperCase())}),'NAME');});

test('same-spelling cwd parent must also have the bound temporary root identity',t=>{const f=fixture(t),original=fs.statSync;const other=path.join(f.directory,'other');fs.mkdirSync(other);const alien=original(other,{bigint:true});t.mock.method(fs,'statSync',(target,options)=>path.resolve(target)===native(f.directory)?alien:original(target,options));reject(()=>capturePaths(args(f)),'OUTSIDE');});

test('same-spelling schema parent must also have the working directory identity',t=>{const f=fixture(t),original=fs.statSync;const alien=original(f.directory,{bigint:true});t.mock.method(fs,'statSync',(target,options)=>path.resolve(target)===native(f.cwd)?alien:original(target,options));reject(()=>capturePaths(args(f)),'OUTSIDE');});

test('same-spelling output parent identity is checked separately',t=>{const f=fixture(t),original=fs.statSync;const alien=original(f.directory,{bigint:true});let count=0;t.mock.method(fs,'statSync',(target,options)=>path.resolve(target)===native(f.cwd)&&++count===2?alien:original(target,options));reject(()=>capturePaths(args(f)),'OUTSIDE');});
