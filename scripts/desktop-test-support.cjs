// Shared support for isolated desktop scenarios. Never attaches to an installed app.
const fs=require('node:fs'),path=require('node:path');
const {_electron}=require('playwright');
const os=require('node:os');
const root=path.resolve(__dirname,'..');
const reportDir=process.env.DESKTOP_TEST_REPORT_DIR||path.join(root,'artifacts/desktop-regression');
const electron={async launch(options){
 if(!options?.env?.ASSISTANT_TEST_DATA_DIR)throw Error('Desktop tests require an isolated ASSISTANT_TEST_DATA_DIR');
 if(!fs.realpathSync(options.env.ASSISTANT_TEST_DATA_DIR).startsWith(fs.realpathSync(os.tmpdir())+path.sep))throw Error('Desktop data must be in a temporary directory');
 const args=(options.args||[]).map(value=>value==='.'?'scripts/standard-desktop-fixture.cjs':value);
 const {assistantTestGuide,...launchOptions}=options;const app=await _electron.launch({...launchOptions,args:['scripts/desktop-test-bootstrap.cjs'],env:{...options.env,ASSISTANT_DESKTOP_FIXTURE:args[0]}});
 const first=app.firstWindow.bind(app),close=app.close.bind(app);let page;
 app.firstWindow=async(...input)=>{page=await first(...input);if(!page.__fixtureReady){await page.waitForFunction(()=>!!document.querySelector('.sidebar'));const skip=page.getByRole('button',{name:'暂时跳过',exact:true});if(!assistantTestGuide&&await skip.count()){await skip.click();await skip.waitFor({state:'hidden'});}page.__fixtureReady=true;}return page;};
 app.close=async()=>{try{if(page&&!page.isClosed()){fs.mkdirSync(reportDir,{recursive:true});const stem=path.basename(process.argv[1],'.cjs');fs.writeFileSync(path.join(reportDir,stem+'-state.json'),JSON.stringify(await page.evaluate(async()=>(await window.assistant.call('state')).data),null,2));fs.writeFileSync(path.join(reportDir,stem+'-ui.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(reportDir,stem+'.png')});}}catch(error){console.error('Desktop evidence:',error.message);}finally{await close();}};
 return app;
}};
async function expandQuick(quick){await quick.getByRole('button',{name:'新建事项',exact:true}).click();const title=quick.getByText('标题与所属项目（可选）',{exact:true});if(!(await quick.getByLabel('快速收集标题').isVisible()))await title.click();}
async function waitSaved(page,quick,{title,count,timeout=30000}={}){const {expect}=require('playwright/test');await expect(quick.getByLabel('快速收集正文')).toHaveValue('');await expect(quick.locator('.file-chip')).toHaveCount(0);await expect.poll(async()=>{const s=(await page.evaluate(()=>window.assistant.call('state'))).data;return s.captureQueue.findLast(row=>title?row.itemTitles.includes(title):true)?.status;},{timeout}).toBe('completed');if(count!==undefined)await expect.poll(async()=>(await page.evaluate(()=>window.assistant.call('state'))).data.sources.length,{timeout}).toBe(count);}
module.exports={electron,expandQuick,waitSaved};
