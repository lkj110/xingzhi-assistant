'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const native={skip:process.platform!=='win32'};
test('Windows OCR recognizes actual Chinese/English PNG entirely through stdin',native,async()=>{
  const {image}=require('./helpers/windows-fixtures.cjs');
  const result=await require('../desktop/image-ocr.cjs').recognize(image().toBuffer('image/png'));
  assert.match(result.lines.map(l=>l.text).join(''),/行知助手.*Windows.*7200/);
  assert.equal(result.width,1200);assert.equal(result.height,300);
  assert.ok(result.lines.every(l=>l.box.y<0.5&&l.box.height>0&&l.confidence===0));
});
test('Windows scans PDF with real WinRT rendering and passes document-worker import',native,async()=>{
  const bytes=require('./helpers/windows-fixtures.cjs').scannedPDF();
  const result=await require('../desktop/documents.cjs').parse('扫描测试.pdf',bytes);
  assert.match(result.content,/行知助手.*Windows.*7200/);
  assert.ok(result.segments.every(s=>s.page===1&&s.localOCR===true));
});
test('Windows respects phone JPEG orientation in recognized text and dimensions',native,async()=>{
 const result=await require('../desktop/image-ocr.cjs').recognize(require('./helpers/windows-fixtures.cjs').orientedJpeg());
 assert.equal(result.width,1200);assert.equal(result.height,300);assert.match(result.lines.map(l=>l.text).join(''),/行知助手.*7200/);
});
test('Windows native OCR cancellation terminates a real helper without returning partial text',native,async()=>{
  const controller=new AbortController();let pid;
  const result=require('../desktop/image-ocr.cjs').recognize(require('./helpers/windows-fixtures.cjs').image().toBuffer('image/png'),controller.signal,{spawnImpl:(...args)=>{const child=cp.spawn(...args);pid=child.pid;setTimeout(()=>controller.abort(),30);return child;}});
  await assert.rejects(result,{code:'OCR_CANCELLED'});assert.throws(()=>process.kill(pid,0));
});
test('Windows OCR rejects corrupted input and oversized buffers',native,async()=>{
  const ocr=require('../desktop/image-ocr.cjs');
  await assert.rejects(ocr.recognize(Buffer.alloc(10000001)),{code:'OCR_LIMIT'});
  await assert.rejects(ocr.recognize(Buffer.from([137,80,78,71,13,10,26,10])),{code:'OCR_FAILED'});
});
test('Windows directory persistence validates existing directories and rejects missing paths',native,()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-win-sync-'));
  try{require('../desktop/filesystem-platform.cjs').syncDirectory(dir);assert.throws(()=>require('../desktop/filesystem-platform.cjs').syncDirectory(path.join(dir,'missing')),{code:'ENOENT'});}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Windows executable discovery handles spaces, uses native executables, and preserves required OS environment',native,()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'行知 executable '));const host=require('../desktop/host-process.cjs');
  try{fs.writeFileSync(path.join(dir,'tool.cmd'),'untrusted shell');assert.equal(host.executable('tool',{dirs:[dir]}),null);fs.writeFileSync(path.join(dir,'tool.exe'),'fixture');assert.equal(host.executable('tool',{dirs:[dir]}),path.join(dir,'tool.exe'));assert.ok(host.environment().SystemRoot||host.environment().SYSTEMROOT);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
