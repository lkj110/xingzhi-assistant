// A verified synthetic CLI identity, separate from each test's data transport.
// No permission functions are mocked: production bootstrap/binding still runs.
const {command}=require('../../desktop/data-platform.cjs');
const identityCommand=JSON.stringify(command({op:'identity'}));
function install(a,{username='fixture-user',tenantId}={}){
 const fixture={identity:{username,...(tenantId?{tenantId}:{})},identityCalls:0};
 let dataRequest=async()=>{throw Error('Unexpected platform data request');};
 const request=async(args,options)=>{
  if(JSON.stringify(args)===identityCommand){fixture.identityCalls++;return structuredClone(fixture.identity);}
  return dataRequest(args,options);
 };
 Object.defineProperty(a,'platformRequest',{configurable:true,get:()=>request,set:value=>{dataRequest=value;}});
 a.platformFixture=fixture;
 return fixture;
}
module.exports={install};
