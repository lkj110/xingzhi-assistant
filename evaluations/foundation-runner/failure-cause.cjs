'use strict';
// Classification only: every returned event remains terminal. No retry policy,
// usage inference, credential access or model request belongs in this module.
const crypto=require('node:crypto');
const connectionCodes=new Set(['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN']);
const schemaCodes=new Set(['invalid_json_schema','invalid_response_format']);
function classifyFailureEvent(event){
 if(!event||!['error','turn.failed'].includes(event.type))return null;
 const detail=event.error&&typeof event.error==='object'?event.error:event;
 const message=typeof detail.message==='string'?detail.message:'';
 if(connectionCodes.has(detail.code))return {code:'CLI_CONNECTION_ERROR',message:'CLI reported a connection failure'};
 if(schemaCodes.has(detail.code))return {code:'CLI_SCHEMA_REJECTED',message:'CLI reported a structured response schema rejection'};
 // Match the observed CLI diagnostic, not arbitrary quoted request/model text.
 if(message==='workspace routing discovery timed out'||/^Reconnecting\.\.\. [1-9]\d*\/[1-9]\d* \(workspace routing discovery timed out\)$/.test(message))return {code:'CLI_ROUTING_TIMEOUT',message:'CLI workspace routing discovery timed out'};
 return event.type==='turn.failed'?{code:'CLI_TURN_FAILED',message:'CLI reported a failed turn; cause not classified'}:{code:'CLI_ERROR_EVENT',message:'CLI reported an error; cause not classified'};
}
const safeCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:null;
function ledgerStopError(stop,phase){
 const code=safeCode(stop.reason)||'RUNNER_LEDGER_STOPPED',ledgerCode=safeCode(stop.code)||'LEDGER_STOPPED';
 const cause=Object.assign(new Error('Ledger stopped: '+ledgerCode),{code:ledgerCode});
 const problem=Object.assign(new Error('Evaluation stopped: '+code,{cause}),{code});
 // Keep the original first-stop identity without copying an unbounded/free-form
 // ledger reason into the public/top-level error. Raw private evidence remains.
 problem.stopCause={phase,code,ledgerCode,reasonSha256:crypto.createHash('sha256').update(String(stop.reason??'')).digest('hex')};
 return problem;
}
module.exports={classifyFailureEvent,ledgerStopError};
