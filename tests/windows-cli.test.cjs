'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const windows={skip:process.platform!=='win32'};
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'行知 CLI 中文 '))),previous={PATH:process.env.PATH,CODEX_HOME:process.env.CODEX_HOME};
 process.env.PATH=dir+path.delimiter+path.dirname(process.execPath);process.env.CODEX_HOME=path.join(dir,'empty-profile');
 t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(dir,{recursive:true,force:true});});
 return dir;
}
test('Windows native enterprise CLI transport preserves Chinese data through the Job supervisor',windows,async t=>{
 const dir=fixture(t);require('./helpers/native-cli.cjs').write(path.join(dir,'bytedcli'),`console.log(JSON.stringify({status:'success',data:{title:'中文平台资料',args:process.argv.slice(2)}}));`);
 const platform=require('../desktop/data-platform.cjs'),args=platform.command({op:'task',taskId:1});
 assert.deepEqual(await platform.execute(args),{title:'中文平台资料',args});
});
test('Windows npm CLI resolves a standard shim without running batch contents',windows,async t=>{
 const dir=fixture(t),script=path.join(dir,'node_modules/bytedcli/cli.cjs'),marker=path.join(dir,'batch-ran');fs.mkdirSync(path.dirname(script),{recursive:true});
 fs.writeFileSync(script,`console.log(JSON.stringify({status:'success',data:{title:'npm 平台资料'}}));`);
 fs.writeFileSync(path.join(dir,'bytedcli.cmd'),`@ECHO off\r\necho unsafe > "${marker}"\r\n"%dp0%\\node_modules\\bytedcli\\cli.cjs" %*\r\n`);
 assert.equal(require('../desktop/host-process.cjs').npmScript('bytedcli',[dir]),script);
 const platform=require('../desktop/data-platform.cjs');assert.deepEqual(await platform.execute(platform.command({op:'task',taskId:2})),{title:'npm 平台资料'});assert.equal(fs.existsSync(marker),false);
 fs.writeFileSync(path.join(dir,'bytedcli.cmd'),'"%dp0%\\..\\escaped.js" %*');assert.equal(require('../desktop/host-process.cjs').npmScript('bytedcli',[dir]),null);
});
test('Windows subscription uses a real PE CLI, pipes Chinese input, reads structured output and reports usage',windows,async t=>{
 const dir=fixture(t);require('./helpers/native-cli.cjs').write(path.join(dir,'codex'),`
 const args=process.argv.slice(2);if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
 let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{
 if(!text.includes('中文请求'))process.exit(9);
 require('fs').writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({response_json:JSON.stringify({content:'中文结果'})}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:5}}));});
 `);
 let usage;const result=await require('../desktop/subscription.cjs').chat({model:'synthetic-fixture'},'',[{role:'user',content:'中文请求'}],{onUsage:value=>usage=value});
 assert.deepEqual(result,{content:'中文结果'});assert.equal(usage.inputTokens,12);assert.equal(usage.outputTokens,5);
});
