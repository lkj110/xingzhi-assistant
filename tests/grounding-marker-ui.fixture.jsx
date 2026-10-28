import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import MarkerConfirmation from '../src/MarkerConfirmation';
import '../src/styles.css';

const original={id:'notice-task',status:'waiting',markerReviewHold:{reportHash:'review-1',phase:'result'},grounding:{passed:false,basis:'basis-1',reportHash:'review-1',reviewDisposition:'marker_confirmation',markerReview:[{claimId:'n1',artifactId:'draft',text:'仅当入口关闭时，请到北侧等候；其他情况仍在原处。'}],claims:[{id:'n1',artifactId:'draft',text:'仅当入口关闭时，请到北侧等候；其他情况仍在原处。',citations:[{title:'预约附记',quote:'入口关闭时改在北侧等候，其他情况在原处。'}]}]}};
window.commands=[];window.pending=[];
function Fixture(){
  const [task,setTask]=useState(structuredClone(original)),[busy,setBusy]=useState(false);
  window.renderMarkerCase=options=>{const next={...structuredClone(original),...options};setTask(next);setBusy(options.busy===true);};
  async function act(action,input){
    window.commands.push({action,input});
    if(window.defer)await new Promise(resolve=>window.pending.push(resolve));
    if(window.fail)throw Error(window.fail);
    if(action==='confirmGroundingMarkers')setTask(old=>({...old,groundingMarkerConfirmation:{actor:'user',reportHash:input.expectedReportHash,basis:old.grounding.basis,confirmedAt:'2026-10-28T12:00:00Z'}}));
  }
  return <main style={{maxWidth:620,margin:'20px auto',padding:16}}><MarkerConfirmation task={task} busy={busy} act={act}/></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
