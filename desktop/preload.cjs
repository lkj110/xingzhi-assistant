const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('assistant', {
  desktop: true,
  quickCaptureSupported: process.argv.includes('--assistant-quick-capture-supported'),
  quickCaptureWindow: process.argv.includes('--assistant-quick-capture-window'),
  onNavigate: callback => {
    const handler=(_event,page)=>{if(['attention','capture','settings','board'].includes(page))callback(page);};
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
