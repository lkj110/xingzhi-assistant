const { contextBridge, ipcRenderer } = require('electron');
const navigationRoutes=Object.freeze(['attention','capture','settings','board','help','guide','decisions','decisions:progress','decisions:review']);
contextBridge.exposeInMainWorld('assistant', {
  desktop: true,
  navigationRoutes,
  quickCaptureSupported: process.argv.includes('--assistant-quick-capture-supported'),
  quickCaptureWindow: process.argv.includes('--assistant-quick-capture-window'),
  onNavigate: callback => {
    const handler=(_event,page)=>{if(navigationRoutes.includes(page))callback(page);};
    ipcRenderer.on('assistant:navigate',handler);
    return ()=>ipcRenderer.removeListener('assistant:navigate',handler);
  },
  onQuickCaptureChange: callback => {
    const handler=()=>callback();ipcRenderer.on('assistant:quick-capture-changed',handler);
    return ()=>ipcRenderer.removeListener('assistant:quick-capture-changed',handler);
  },
  onEngineStatus: callback => {
    const handler=(_event,status)=>callback(status);ipcRenderer.on('assistant:engine-status',handler);
    return ()=>ipcRenderer.removeListener('assistant:engine-status',handler);
  },
  call: (action, input) => ipcRenderer.invoke('assistant:call', action, input)
});
