'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const deny=()=>{throw Error('final-platform fixture: real I/O forbidden');};
require('node:net').Socket.prototype.connect=deny;global.fetch=deny;
// Exercise the production process collector without executing any binary.
let scenario;const kills=[];
(process.platform==='win32'?require('../desktop/windows-process.cjs'):require('node:child_process')).spawn=(bin,args,options)=>{
 assert.ok(/(?:^|[\\/])bytedcli(?:\.exe)?$/.test(bin));assert.equal(options.shell,false);
 const child=new EventEmitter();child.pid=987654321;child.stdout=new PassThrough();child.stderr=new PassThrough();
 process.nextTick(()=>scenario(child,args));return child;
};
const stat=fs.statSync,access=fs.accessSync;
fs.statSync=(file,...rest)=>/(?:^|[\\/])bytedcli(?:\.exe)?$/.test(String(file))?{isFile:()=>true}:stat(file,...rest);
fs.accessSync=(file,...rest)=>/(?:^|[\\/])bytedcli(?:\.exe)?$/.test(String(file))?undefined:access(file,...rest);
if(process.platform==='win32')require('../desktop/host-process.cjs').terminate=(child,signal='SIGTERM')=>kills.push(signal);
process.kill=(pid,signal)=>{assert.equal(pid,-987654321);kills.push(signal);};
const platform=require('../desktop/data-platform.cjs'),storage=require('../desktop/platform-result.cjs');
const lineage=platform.command({op:'table_lineage',database:'db',table:'out'}),ordinary=platform.command({op:'task',taskId:1});
function stream(chunks,{stderr=[],code=0}={}){scenario=child=>{for(const b of chunks)child.stdout.write(b);for(const b of stderr)child.stderr.write(b);child.emit('close',code);};}

test('Coral accepts >2MB within fixed transport budget and preserves split multibyte UTF-8 exactly',async()=>{
 const data={text:'x'.repeat(2_100_000),tail:'中心证据🧭'};const bytes=Buffer.from(JSON.stringify({status:'success',data}));
 const split=bytes.indexOf(Buffer.from('中心'))+1;stream([bytes.subarray(0,split),bytes.subarray(split,split+2),bytes.subarray(split+2)]);
 assert.deepEqual(await platform.execute(lineage),data);assert.equal(kills.length,0);
 assert.equal(lineage.includes('--depth'),false);assert.equal(lineage.includes('--page'),false);
});
test('ordinary and Coral stdout over their own limit cannot turn a valid success prefix into evidence',async()=>{
 for(const [args,limit] of [[ordinary,storage.limits.ordinaryBytes],[lineage,storage.limits.lineageBytes]]){
  const first=Buffer.from('{"status":"success","data":{"nodes":[]}}\n'),rest=Buffer.alloc(limit+1,32);stream([first,rest]);
  await assert.rejects(platform.execute(args),e=>{
   const d=platform.safeDiagnostics(e);assert.equal(e.code,'INVALID_PLATFORM_RESPONSE');assert.equal(d.reason,'stdout_limit');assert.equal(d.limitBytes,limit);assert.equal(d.stdoutBytes,first.length+rest.length);assert.equal(d.stdoutComplete,false);assert.match(d.stdoutSha256,/^[a-f0-9]{64}$/);return true;
  });
 }
 assert.ok(kills.includes('SIGTERM'));
});
test('unknown actual business-code shapes keep safe causal fingerprints without free-form diagnostics',()=>{
 for(const code of [3003,34013]){
  const raw=JSON.stringify({status:'error',error:{code:'CORAL_API_ERROR',message:'PRIVATE_MESSAGE https://login.invalid/?token=PRIVATE_TOKEN',details:{code,cookie:'PRIVATE_COOKIE'}}});
  assert.throws(()=>platform.parse(raw),e=>{
   const d=platform.safeDiagnostics(e);assert.equal(e.code,'INVALID_PLATFORM_RESPONSE');assert.equal(d.symbolicCode,'CORAL_API_ERROR');assert.equal(d.details.code,code);assert.equal(d.stdoutBytes,Buffer.byteLength(raw));assert.equal(d.stdoutSha256,storage.digest(raw));assert.equal(d.responseFormat,'error_envelope');assert.doesNotMatch(JSON.stringify(d),/PRIVATE_|login.invalid|message|cookie/);return true;
  });
 }
});
test('non-JSON and malformed successful envelope cannot produce empty success; changing content changes the diagnostic digest',()=>{
 const digests=[];
 for(const raw of ['not json PRIVATE_TOKEN','different PRIVATE_TOKEN','{"status":"success"}','{"data":[]}'])assert.throws(()=>platform.parse(raw),e=>{const d=platform.safeDiagnostics(e);digests.push(d.stdoutSha256);assert.equal(e.code,'INVALID_PLATFORM_RESPONSE');assert.ok(['invalid_json','invalid_envelope'].includes(d.responseFormat));assert.doesNotMatch(JSON.stringify(d),/PRIVATE_/);return true;});
 assert.equal(new Set(digests).size,4);
});
test('stderr is bounded but fully fingerprinted; nonzero exit after success stays failure',async()=>{
 const err=Buffer.from('PRIVATE_STDERR '.repeat(4000));stream([Buffer.from('{"status":"success","data":{}}')],{stderr:[err],code:17});
 await assert.rejects(platform.execute(lineage),e=>{const d=platform.safeDiagnostics(e);assert.equal(d.exitCode,17);assert.equal(d.reason,'process_exit');assert.equal(d.stderrBytes,err.length);assert.equal(d.stderrSha256,storage.digest(err));assert.doesNotMatch(JSON.stringify(d),/PRIVATE_/);return true;});
});
test('transport cancellation wins over a late apparently successful payload',async()=>{
 const c=new AbortController();scenario=child=>{c.abort();child.stdout.write('{"status":"success","data":{}}');child.emit('close',0);};
 await assert.rejects(platform.execute(lineage,{signal:c.signal}),e=>/已停止/.test(e.message)&&e.diagnostics.stdoutComplete===false);
});
test('untrusted diagnostic properties do not escape the typed allowlist',()=>{
 const d=platform.safeDiagnostics({diagnostics:{stage:'PRIVATE_STAGE',reason:'PRIVATE_REASON',stdoutSha256:'PRIVATE_TOKEN',stdoutBytes:'123',stderrBytes:-1,limitBytes:Infinity,errorSha256:storage.digest('opaque'),message:'PRIVATE_MESSAGE',archive:'PRIVATE_ARCHIVE'}});
 assert.deepEqual(d,{errorSha256:storage.digest('opaque')});
});
