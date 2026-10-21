const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, Tray, nativeImage, shell, Notification, powerMonitor, net, globalShortcut, clipboard, screen, systemPreferences } = require('electron');
const path = require('node:path');
const { EngineClient } = require('./engine-client.cjs');
const { createNativeBridge } = require('./native-bridge.cjs');
const quickCaptureModule = require('./quick-capture.cjs');

app.setName('行知助手');
if(process.platform==='win32')require('./windows-shell.cjs').configure(app);
if (process.env.ASSISTANT_TEST_DATA_DIR && !app.isPackaged) app.setPath('userData', process.env.ASSISTANT_TEST_DATA_DIR);
let window, engine, tray, pendingBadges, timer, quickCapture, selectionCapture, quitting = false, shutdownComplete = false;
const ownsInstanceLock=app.requestSingleInstanceLock();
if (!ownsInstanceLock) app.quit();
app.on('second-instance', () => showWindow());
const showWindow = () => { if (!quitting && window && !window.isDestroyed()) { window.show(); window.focus(); } };
function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 1000, minHeight: 700,
    title: '行知 · 个人工作助手', backgroundColor: '#f8faf9',
    ...(process.platform==='darwin'?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:20,y:20}}:{titleBarStyle:'default',icon:path.join(__dirname,'assets/icon.png')}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: [quickCaptureModule.FLAG] }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.loadFile(path.join(__dirname, '../dist/index.html'));
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
}
app.whenReady().then(async () => {
  if(!ownsInstanceLock||quitting)return;
  // Explicit portable/test profiles do not register a global Start Menu entry.
  if(process.platform==='win32'&&app.isPackaged&&!app.commandLine.hasSwitch('user-data-dir')){
    try{require('./windows-shell.cjs').shortcut({app,shell});}catch(error){console.error(error.message);}
  }
  const dir = path.join(app.getPath('userData'), 'workspace');
  const native=createNativeBridge({app,dialog,shell,Notification,net,getWindow:()=>window,onAttention:()=>{showWindow();window?.webContents.send('assistant:navigate','attention');}});
  const inlineFixture=!app.isPackaged&&process.env.ASSISTANT_DESKTOP_FIXTURE&&process.env.ASSISTANT_ENGINE_WORKER!=='1';
  if(!app.isPackaged&&process.env.ASSISTANT_DESKTOP_FIXTURE&&!inlineFixture&&!process.env.ASSISTANT_ENGINE_FIXTURE)throw Error('隔离 Worker 测试需提供临时 ASSISTANT_ENGINE_FIXTURE');
  engine=inlineFixture?require('./engine-client-inline.cjs').createInlineFixture({dir,safeStorage,native,isPackaged:app.isPackaged}):new EngineClient({dir,safeStorage,native,fixtureModule:!app.isPackaged?process.env.ASSISTANT_ENGINE_FIXTURE:undefined});
  engine.on('failure',()=>{if(!quitting){quickCapture?.hide();window?.webContents.send('assistant:engine-status',{available:false,message:'业务进程已停止，请重新启动应用'});}});
  engine.on('mirror',()=>{pendingBadges?.schedule();quickCapture?.reconcile();selectionCapture?.reconcile();});
  await engine.ready;
  if(quitting)return;
  const adapter=engine.captureAdapter();
  const screenshot = require('./screenshot.cjs').create({clipboard,nativeImage});
  quickCapture = quickCaptureModule.createController({ resolveSelection:token=>selectionCapture.resolve(token), screenshot, screen, adapter, BrowserWindow, globalShortcut, preload:path.join(__dirname,'preload.cjs'), indexFile:path.join(__dirname,'../dist/index.html'), showMain:page=>{showWindow();window?.webContents.send('assistant:navigate',page);} });
  selectionCapture=require('./selection-capture.cjs').create({assistant:engine.fixtureAssistant,adapter,globalShortcut,systemPreferences,dismissSelection:point=>quickCapture.dismissSelection(point),capture:()=>screenshot('screenshotRegion',BrowserWindow.getFocusedWindow()),openCapture:(context,mini)=>quickCapture.openCapture(context,mini),canShow:()=>quickCapture.canShowSelection()});
  quickCapture.reconcile();selectionCapture.reconcile();
  ipcMain.handle('assistant:call', async (event, action, input) => {
    if(quitting)return {error:'应用正在退出'};
    if(quickCapture.matchesWindow(event)){try{return {data:await quickCapture.dispatchSmall(event,action,input)};}catch(error){return {error:error.message};}}
    if (!quickCaptureModule.trustedSender(window,event,path.join(__dirname,'../dist/index.html'))) throw new Error('无效的调用来源');
    try {
      // uiCommand is retained for all engine work, including desktop commands
      // whose business half (validation/save) runs in the worker.
      const nativeAction=action==='uiCommand'?input?.action:action,nativeInput=action==='uiCommand'?input?.input:input;
      if(nativeAction==='registrationOpen'){
        if(action!=='uiCommand')throw Error('请从注册指南打开官方入口');
        const guide=require('./registration-guides.json').find(g=>g.id===nativeInput?.id);
        if(!guide)throw Error('未知平台注册入口');
        await shell.openExternal(guide.url);return {data:{opened:true}};
      }
      if(['agentStorageMethodResume','agentStorageMethodResumePreview'].includes(nativeAction)&&action!=='uiCommand')throw Object.assign(Error('技术恢复必须通过可信界面操作'),{code:'TRUSTED_UI_COMMAND_REQUIRED'});
      if(nativeAction==='screenshotRegion'||nativeAction==='screenshotClipboard')return {data:await screenshot(nativeAction,window)};
      if(nativeAction==='quickCaptureDetectionStatus')return {data:selectionCapture.reconcile()};
      if(nativeAction==='quickCapturePermission'){
        if(process.platform!=='darwin')throw Error('此权限入口仅支持 macOS');
        if(!['accessibility','screen'].includes(nativeInput?.kind))throw Error('权限类型无效');
        if(nativeInput.kind==='accessibility')systemPreferences.isTrustedAccessibilityClient(true);
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?'+(nativeInput.kind==='accessibility'?'Privacy_Accessibility':'Privacy_ScreenCapture'));
        return {data:selectionCapture.reconcile()};
      }
      if(nativeAction==='quickCaptureDetectionConfigure')return {data:await selectionCapture.configure(nativeInput)};
      if(nativeAction==='quickCaptureScreenshot'){await selectionCapture.screenshot();return {data:selectionCapture.status()};}
      if(typeof nativeAction==='string'&&nativeAction.startsWith('quickCapture'))return {data:await quickCapture.dispatchMain(nativeAction,nativeInput)};
      return {data:await engine.dispatch(action,input)};
    } catch (error) { return { error: error.message, ...(error.code?{code:error.code}:{}), ...(typeof error.committed==='boolean'?{committed:error.committed}:{}) }; }
  });
  const control=(action,input)=>engine.control(action,input).catch(()=>{if(!quitting)window?.webContents.send('assistant:engine-status',{available:false,message:'后台操作未完成，请检查工作台'});});
  powerMonitor.on('suspend',()=>control('suspend'));
  powerMonitor.on('resume',()=>control('resume'));
  createWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '行知助手', submenu: [{ label: '显示工作台', click: showWindow }, { label: '快速收集', click:()=>quickCapture.open() }, { type: 'separator' }, { role: 'hide', label: '隐藏行知助手' }, { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { label: '退出行知助手', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '显示', submenu: [{ label: '重新加载工作台', accelerator: 'CmdOrCtrl+R', click: () => window.reload() }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '帮助', submenu: [{ label: '使用说明', click: () => { showWindow();window.webContents.send('assistant:navigate','help'); } }, { label: '快速上手', click: () => { showWindow();window.webContents.send('assistant:navigate','guide'); } }] }
  ]));
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/tray.png')).resize({ width: 22, height: 22 });
  if(process.platform==='darwin')icon.setTemplateImage(true); tray = new Tray(icon); tray.setToolTip('行知助手 · 本地工作台');
  pendingBadges=require('./pending-badges.cjs').create({app,tray,Menu,nativeImage,getWindow:()=>window,getCounts:()=>engine.mirror?.pending,showMain:showWindow,openPending:category=>{showWindow();window?.webContents.send('assistant:navigate',category==='all'?'decisions':'decisions:'+category);},openCapture:()=>quickCapture.open(),pause:()=>control('stop'),quit:()=>app.quit()});
  pendingBadges.refresh();
  tray.on('click', showWindow);
  timer = setInterval(() => {
    quickCapture.reconcile();selectionCapture.reconcile();
    void control('connectivity',{online:net.isOnline()});
  }, 15000);
  void control('connectivity',{online:net.isOnline()});
}).catch(error => { dialog.showErrorBox('行知助手无法启动', error.message); app.quit(); });
app.on('activate', showWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if(shutdownComplete)return;
  event.preventDefault();
  if(quitting)return;
  quitting=true;pendingBadges?.dispose();quickCapture?.dispose();selectionCapture?.dispose();clearInterval(timer);
  // Do not let Electron exit while the sole writer is still committing or
  // unwinding aborted work. close() bounds shutdown and terminates a stuck worker.
  Promise.resolve(engine?.close()).catch(error=>{console.error('业务进程关闭失败:',error.code||'ENGINE_SHUTDOWN_FAILED');}).finally(()=>{shutdownComplete=true;app.quit();});
});
