'use strict';
function unavailable(){return Object.assign(new Error('Private historical evidence is not distributed in this public source tree. Synthetic tests do not establish private release eligibility.'),{code:'PRIVATE_HISTORY_UNAVAILABLE'});}
function main(){const error=unavailable();process.stderr.write(JSON.stringify({status:'unavailable',code:error.code,message:error.message,productionDelivery:'not_verified'})+'\n');process.exitCode=1;}
module.exports={unavailable,main};
if(require.main===module)main();
