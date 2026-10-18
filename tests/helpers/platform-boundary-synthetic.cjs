'use strict';
const config={"down":[710000048,700001201,710000034,710000035,710000041,710000036,710000037,710000038,710000039,710000042,710000043],"up":[700001203,700001204],"roots":[700000101,700000102,700000103,700000104,700000105,700000106],"projects":[710000018,710000013,710000012,710000011],"extra":710000040,"bridge":[710000044,710000046]};
const {down,up,roots,projects,extra,bridge}=config;
const confirmedAt='2032-01-10T12:00:00Z';
const contract={revision:'synthetic-contract',updatedAt:'2032-01-20T00:00:00Z',text:'入口任务 IDs: '+roots.join(', ')+'\n用户已选择先保留缺口，完成可访问部分；权限不可访问的分支明确标注并继续其余部分。保留已发现的权限边界。'};
const directives=[{id:'synthetic-denial-directive',at:'2032-01-10T10:00:00Z',origin:'user_feedback',text:'合成测试：已独立复现 '+down[7]+' 的下游查询，平台明确返回没有项目 '+projects[1]+' 的访问权限；同项目的 '+down.slice(8).join('、')+' 也已查询失败。请把这些列为权限边界，不反复重试。'},{id:'synthetic-set-directive',at:confirmedAt,origin:'user_feedback',text:'禁止重复探测十三个已确认权限边界，禁止扩展无关旁路祖先。'}];
function metadata(){
 const directions=[...down.map((taskId,index)=>({op:'downstream',taskId,projectId:index<2?projects[0]:projects[1],late:index>=7})),...up.map(taskId=>({op:'upstream',taskId,projectId:projects[2],late:false})),{op:'downstream',taskId:extra,projectId:projects[1],late:true},...Array.from({length:10},(_,index)=>({op:'upstream',taskId:711000001+index,projectId:712000001+index,late:true}))];
 return [...directions.map(value=>({...value,depth:1})),...directions.map(value=>({...value,depth:2})),...directions.slice(0,11).map(value=>({...value,depth:3}))].map((value,index)=>[value.op,String(value.taskId),String(value.projectId),value.depth,value.late?'2032-01-19T09:00:00Z':'2032-01-09T09:00:00Z','synthetic-operation-'+index]);
}
const edges=down.map((id,index)=>[roots[index%roots.length],id,index<2?projects[0]:projects[1]]);edges.push([down[6],extra,projects[1]]);
const downstream={nodes:[...roots.map(id=>({id,projectId:projects[3],parentRelation:[]})),...edges.map(([parent,id,projectId])=>({id,projectId,parentRelation:[{id:parent}]}))]};
const upstream={nodes:[{id:roots[2],projectId:projects[3],parentRelation:[{id:bridge[0]}]},{id:bridge[0],projectId:projects[3],parentRelation:[{id:bridge[1]}]},{id:bridge[1],projectId:projects[3],parentRelation:up.map(id=>({id}))},...up.map(id=>({id,projectId:projects[2]}))]};
module.exports={config,confirmedAt,contract,directives,metadata,downstream,upstream};
