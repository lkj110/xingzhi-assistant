// Isolated UI fixture. Never reads or writes the user's workspace.
const fs=require('fs'),os=require('os'),path=require('path');
const {startServer}=require('../desktop/server.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-results-ui-'));
 const {server,assistant:a,origin}=await startServer({dir,port:0,chat:()=>{throw Error('Fixture must not invoke models');}});
 const t=a.createTask({title:'测试交接：当前成果与历史版本',criteria:'包含已核对的节点和权限范围；未访问部分明确保留。',steps:[{title:'交接文档',kind:'draft'}]});
 for(let i=0;i<6;i++)a.data.artifacts.push({id:'old-'+i,taskId:t.id,stepId:t.steps[0].id,title:'交接文档（完整修订版）',content:'## 历史稿\n测试旧内容 '+i,createdAt:'2026-10-12T09:00:00Z'});
 a.data.artifacts.push({id:'current',taskId:t.id,stepId:t.steps[0].id,title:'交接文档（完整修订版）',content:'## 对外输出节点\n这是隔离测试中的当前成果。\n\n|任务|输入与输出|负责人|\n|---|---|---|\n|123|`example.input` → `example.output`|本人|\n|456|**尚未验证**<br>保留缺口|其他负责人|\n\n## 已知范围\n权限边界未验证。',createdAt:'2026-10-12T10:29:00Z'});
 Object.assign(t,{status:'review',verification:{passed:true,summary:'已核对可访问节点。权限边界未验证，请按约定范围验收。',gaps:[],at:'2026-10-12T10:30:00Z'}});Object.assign(t.steps[0],{done:true,artifactId:'current'});
 const w=a.createTask({title:'测试修订中的事项',criteria:'更新后重新检查',steps:[{title:'重新编写',kind:'draft'}]});Object.assign(w,{status:'blocked',lastError:'补充材料后继续',needsReplan:'来源变化，请重新检查'});a.data.artifacts.push({id:'draft-old',taskId:w.id,stepId:w.steps[0].id,title:'修订前文稿',content:'旧正文',createdAt:'2026-10-12T08:00:00Z'});
 a.save();console.log(JSON.stringify({origin,dir,taskId:t.id}));
 const close=()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0)};process.on('SIGTERM',close);process.on('SIGINT',close);
})();
