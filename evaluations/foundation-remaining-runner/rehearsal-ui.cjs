'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),native=require('./native.cjs');
async function exercise({app,page,output,session,taskId,checks,api,fault}){
 assert.equal(session.mode,'offline');
 if(fault==='phase-stop'){
  fs.writeFileSync(path.join(output,'STOP'),'OFFLINE');
  await page.evaluate(id=>window.assistant.call('advance',{id}),taskId);session.guard();return;
 }
 // The original F04 lifecycle helper has no F04 acceptance action. Its exercise
 // function only opens/hides the actual capture window and compares application state.
 await require('../foundation-native-ui-runner/window-flow.cjs').exercise({app,page,output,session,taskId,checks,api,fault:fault==='capture-submit'||fault==='wrong-window'?fault:undefined});
 const rows=native.records(path.join(output,'native-commands.jsonl'));
 assert.ok(rows.some(r=>r.windowRole==='capture'&&r.kind==='native-command'));
}
module.exports={exercise};
