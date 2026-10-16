// Runs every maintained desktop scenario in its own isolated Electron process.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=process.env.DESKTOP_TEST_REPORT_DIR||path.join(root,'artifacts/desktop-regression');fs.mkdirSync(out,{recursive:true});
const known=require('./desktop-scenarios.cjs');
const scripts=process.argv.slice(2).length?process.argv.slice(2).map(n=>n.startsWith('scripts/')?n:`scripts/${n.endsWith('.cjs')?n:n+'-desktop-smoke.cjs'}`):known;
const results=[];
(async()=>{for(const script of scripts){const name=path.basename(script,'.cjs'),started=Date.now(),log=path.join(out,name+'.log'),stream=fs.createWriteStream(log);console.log('START '+name);
const result=await new Promise(resolve=>{const child=cp.spawn(process.execPath,[script],{cwd:root,env:{...process.env,DESKTOP_TEST_REPORT_DIR:out},detached:true,stdio:['ignore','pipe','pipe']});let timedOut=false;child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000).unref();},name==='desktop-audit'?300000:180000);child.on('exit',(code,signal)=>{clearTimeout(timer);stream.end();resolve({script,code,signal,timedOut,durationMs:Date.now()-started,log});});});
results.push(result);fs.writeFileSync(path.join(out,'suite-results.json'),JSON.stringify(results,null,2));console.log('DONE '+name+' '+result.code+' '+result.durationMs+'ms');}console.log('TOTAL '+results.length+' PASS '+results.filter(x=>x.code===0).length);if(results.some(x=>x.code!==0))process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
