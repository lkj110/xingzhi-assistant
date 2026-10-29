'use strict';
// Observe the sealed supervisor without changing its dispatch, stop or usage rules.
const base=require('../foundation-runner/transport.cjs'),{collector}=require('./diagnostics.cjs');
async function runTransport(options){
 const diagnostic=collector({requestInput:options.input});
 try{
  const result=await base.runTransport({...options,onFrame:frame=>{diagnostic.feed(frame);options.onFrame?.(frame);}});
  return {...result,diagnostics:diagnostic.finish(result)};
 }catch(error){error.diagnostics=diagnostic.finish(error,error);throw error;}
}
module.exports={...base,runTransport};
