// Actual Coral envelope shape, with symbolic (non-business) addresses. No
// complete/noMore/closure flags: closure requires every own center.
const identity=(table='out')=>({entityType:'HiveTable',region:'sg',cid:6,database:'db',table});
const process=(id=123)=>({guid:'process-'+id,typeName:'DoradoTask',attributes:{id,qualifiedName:'DoradoTask:///'+id+'@6',inputs:[],outputs:[],errorMessage:null}});
function node(table='out',extra={}){return {guid:table,typeName:'HiveTable',attributes:{name:table,parentName:'db',qualifiedName:'HiveTable:///db/'+table+'@6',cid:6,inputToProcesses:[],outputFromProcesses:[],...extra}};}
function data(table='out',input=[],output=[]){
 const center=node(table,{outputFromProcesses:input.length?[process(123)]:[],inputToProcesses:output.length?[process(456)]:[]});
 return {baseEntityGuid:table,inputEntityCount:input.length,inputEntityDepth:1,inputEntityGuids:input.length?[input]:[],outputEntityCount:output.length,outputEntityDepth:1,outputEntityGuids:output.length?[output]:[],guidEntityMap:{...Object.fromEntries([...input,...output].map(n=>[n,node(n)])),[table]:center}};
}
const snapshot=(table='out',input=[],output=[],sourceId='source-'+table)=>({sourceId,operation:'table_lineage',region:'sg',query:{op:'table_lineage',database:'db',table},data:data(table,input,output)});
const root=(table='out',rootId='123')=>({rootId,entity:identity(table),proofSourceIds:['mapping-'+rootId]});
module.exports={identity,process,node,data,snapshot,root};
