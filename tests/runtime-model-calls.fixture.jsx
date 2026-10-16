import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import RuntimePage from '../src/RuntimePage';

// Entirely synthetic; requests are resolved by the test, never sent to a workspace.
window.requests=[];
window.pending=[];
window.previewReads=0;
window.assistant={call:(action,input)=>{
  window.requests.push({action,input});
  return new Promise(resolve=>window.pending.push(resolve));
}};
const root=createRoot(document.getElementById('root'));
const act=async()=>[];
window.renderRuntime=(viewRevision='v1',revision=1)=>{
  const data={settings:{compactContext:true},delegations:[{repeatedActions:3}],viewRevision,runtime:{revision}};
  Object.defineProperty(data,'modelCalls',{get(){window.previewReads++;return Array.from({length:8},(_,i)=>({id:`preview-${i}`,model:'PREVIEW-ONLY',status:'done'}));}});
  flushSync(()=>root.render(<RuntimePage data={data} act={act}/>));
};
window.hideRuntime=()=>flushSync(()=>root.render(null));
window.resolveCalls=(index,calls)=>window.pending[index]({data:{calls}});
window.fixtureReady=true;
