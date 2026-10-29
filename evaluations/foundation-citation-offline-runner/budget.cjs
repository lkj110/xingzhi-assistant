'use strict';
const assert=require('node:assert/strict');
function conditions(attempts,limits){
 return limits.map(limit=>{
  const rows=attempts.filter(a=>a.caseId===limit.id&&a.transportPermitted),maxDispatches=limit.attempts-1;assert.ok(rows.length>0&&rows.length<=maxDispatches);
  let prefix=0,peak=0;const measured=rows.map(a=>{const assumedUsage=a.serializedInputBytes+1024;peak=Math.max(peak,prefix+a.reservedTokens);const v={inputBytes:a.serializedInputBytes,schemaBytes:a.schemaBytes,reservation:a.reservedTokens,assumedUsage,prefix,admission:prefix+a.reservedTokens};prefix+=assumedUsage;return v;});
  const observedPeak=peak,maxInput=Math.max(...rows.map(a=>a.serializedInputBytes)),maxReservation=Math.max(...rows.map(a=>a.reservedTokens));
  for(let i=rows.length;i<maxDispatches;i++){peak=Math.max(peak,prefix+maxReservation);prefix+=maxInput+1024;}
  return {caseId:limit.id,observedDispatches:rows.length,maxDispatches,measured,observedConditionalPeak:observedPeak,extendedConditionalPeak:peak,proposedTokenStopThreshold:limit.tokenStopThreshold,conditionalMargin:limit.tokenStopThreshold-peak,notATokenForecast:true};
 });
}
module.exports={conditions};
