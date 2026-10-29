'use strict';
const base=require('../foundation-citation-offline-runner/coverage.cjs');
function coverage(summary,stages=[]){
 const live=summary.mode==='live',f03=stages.filter(s=>s.caseId==='F03-botang-notice');
 return {...base.coverage(summary),citationFields:{stages,synthetic:!live,F03WorkflowCompleted:summary.results.some(r=>r.caseId==='F03-botang-notice'&&r.technicalPassed===true),F03ModelTitleCitationEmitted:f03.some(s=>s.modelTitleCitationEmitted),F03TitleBindingValidated:f03.some(s=>s.titleBindingValidated),F03LiveTitleCitationCovered:live&&f03.some(s=>s.liveTitleBindingValidated),status:live?(f03.some(s=>s.liveTitleBindingValidated)?'observed':'not-covered'):'synthetic-only'}};
}
module.exports={coverage};
