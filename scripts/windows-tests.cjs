'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),files=require('./windows-test-plan.cjs');
for(const file of files)if(!fs.existsSync(path.join(root,file)))throw Error('Missing required Windows test: '+file);
require('./build-windows-native.cjs').build();
console.log(JSON.stringify({windowsRuntimeSuites:files.length,exclusions:files.exclusions}));
const result=cp.spawnSync(process.execPath,['--test','--test-concurrency=4','--test-timeout=60000','--test-reporter=tap',...files],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
if(result.status===0){
 const ui=cp.spawnSync(process.execPath,['--test','--test-timeout=60000','tests/windows-capture-ui.test.cjs'],{cwd:root,stdio:'inherit',windowsHide:true});
 if(ui.error)throw ui.error;process.exitCode=ui.status??1;
}else process.exitCode=result.status??1;
