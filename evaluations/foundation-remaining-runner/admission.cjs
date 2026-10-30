'use strict';
// The suite clock includes asynchronous state reads, not just model runtime.
async function admit({session,identityGuard,phases,call,context,afterAdmission}){
 session.guard();await phases.admit(call,context);
 if(afterAdmission)await afterAdmission();
 identityGuard();session.guard();
}
module.exports={admit};
