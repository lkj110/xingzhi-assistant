'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
test('Windows real UI: selection, explicit copy with clipboard restoration, password refusal and region screenshot',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-ui-')),fixture=path.join(dir,'capture-fixture.exe');
 cp.execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/out:'+fixture,'/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',path.join(__dirname,'helpers/WindowsCaptureFixture.cs')],{stdio:'pipe',windowsHide:true});
 const helper=path.resolve(__dirname,'../desktop/native/bin/windows-capture.exe');
 function messages(child){const rows=[];let pending='';child.stdout.on('data',b=>{pending+=b;let end;while((end=pending.indexOf('\n'))>=0){const text=pending.slice(0,end).replace(/^\uFEFF/,'');pending=pending.slice(end+1);try{rows.push(JSON.parse(text));}catch{}}});return rows;}
 async function until(fn){const end=Date.now()+5000;let v;while(!(v=fn())&&Date.now()<end)await new Promise(r=>setTimeout(r,25));assert.ok(v,'native UI result arrived');return v;}
 const ui=cp.spawn(fixture,[],{stdio:['pipe','pipe','pipe'],windowsHide:true}),events=messages(ui);let monitor,shot;
 t.after(async()=>{monitor?.kill();shot?.kill();if(ui.exitCode===null){ui.stdin.write('quit\n');await new Promise(r=>{ui.once('close',r);setTimeout(()=>{if(ui.exitCode===null)ui.kill();r();},2000).unref();});}fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const info=await until(()=>events.find(r=>r.ready||r.error));assert.equal(info.ready,true,info.error);
 monitor=cp.spawn(helper,['--selection',String(process.pid)],{stdio:['ignore','pipe','pipe'],windowsHide:true});const selections=messages(monitor);
 await until(()=>selections.find(r=>r.type==='status'&&r.trusted));ui.stdin.write('select\n');
 const selected=await until(()=>selections.find(r=>r.type==='selection'||r.type==='candidate'));
 if(selected.type==='selection')assert.equal(selected.text,'Windows selection fixture 7200');
 const request={pid:info.pid,bundleId:info.app,windowTitle:info.title,windowHandle:info.handle};
 const copy=()=>new Promise((resolve,reject)=>{const c=cp.spawn(helper,['--copy-selection'],{stdio:['pipe','pipe','pipe'],windowsHide:true});const rows=messages(c);c.on('error',reject);c.on('close',()=>resolve(rows.find(r=>r.type==='copy_result')));c.stdin.end(JSON.stringify(request)+'\n');});
 const copied=await copy();assert.equal(copied.text,'Windows selection fixture 7200',copied.error);
 ui.stdin.write('check\n');assert.equal((await until(()=>events.find(r=>'clipboardRestored' in r))).clipboardRestored,true);
 ui.stdin.write('password\n');await until(()=>events.find(r=>r.password));assert.ok((await copy()).error,'password cannot be copied');
 ui.stdin.write('pixel\n');const expected=(await until(()=>events.find(r=>r.pixel))).pixel;
 const png=path.join(dir,'region.png');shot=cp.spawn(helper,['--screenshot',png],{stdio:'ignore',windowsHide:true});const finished=new Promise(r=>shot.on('close',r));
 await new Promise(r=>setTimeout(r,650));ui.stdin.write('drag\n');assert.equal(await finished,0);assert.ok(fs.existsSync(png));
 const {loadImage,createCanvas}=require('@napi-rs/canvas'),image=await loadImage(png);assert.equal(image.width,160);assert.equal(image.height,80);
 const canvas=createCanvas(160,80),context=canvas.getContext('2d');context.drawImage(image,0,0);assert.deepEqual([...context.getImageData(80,40,1,1).data],expected);
});
