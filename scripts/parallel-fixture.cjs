const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs');
let a;const gates=new Map();
app.whenReady().then(async()=>{
  a=new Assistant({dir:process.env.ASSISTANT_TEST_DATA_DIR,chat:async(p,k,m,o)=>{
    const goal=JSON.parse(m[1].content).goal;
    await new Promise((resolve,reject)=>{gates.set(goal,resolve);o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true});});
    o.onUsage({inputTokens:100,outputTokens:20});return {tool:'ask',args:{question:'请选择测试交付格式'}};
  }});
  await a.dispatch('saveProvider',{name:'本地测试模型',model:'fixture',baseUrl:'https://example.invalid/v1',inputPrice:0,outputPrice:0});
  a.data.delegations.push(...['并行测试甲','并行测试乙','独立测试丙'].map(goal=>agent.buildJob(a,{goal,allowWeb:false,maxActions:1})));
  require('../desktop/onboarding.cjs').dismiss(a);
  ipcMain.handle('assistant:call',async(_e,action,input)=>{try{
    if(action==='fixtureStart'){for(const j of a.data.delegations.slice(0,2))await a.dispatch('agentRun',{id:j.id});return {data:a.publicState()};}
    if(action==='fixtureRelease'){for(const release of gates.values())release();await a.runPromise;return {data:a.publicState()};}
    return {data:await a.dispatch(action,input)};
  }catch(error){return {error:error.message};}});
  const window=new BrowserWindow({width:1350,height:950,webPreferences:{preload:path.join(__dirname,'../desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false}});
  await window.loadFile(path.join(__dirname,'../dist/index.html'));
});
app.on('before-quit',()=>a?.stop());
