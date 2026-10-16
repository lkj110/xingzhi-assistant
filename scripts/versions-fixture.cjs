const path=require('node:path');
const dir=process.env.ASSISTANT_TEST_DATA_DIR;if(!dir)throw new Error('Isolated data required');
const core=require('../desktop/core.cjs'),Base=core.Assistant,calls={models:0,requests:0,messages:0};
function addSource(a,id,title,content,identity,previousSourceId=null,patch={}){
 const previous=a.data.sources.find(source=>source.id===previousSourceId),project=a.data.projects.find(project=>project.name==='青禾版本项目');
 const source={id,title,content,origin:'隔离测试材料',projectId:project.id,identity,state:'processed',format:'txt',version:previous?(previous.version||1)+1:1,createdAt:new Date(Date.now()-60000+a.data.sources.length*500).toISOString(),...(previous?{previousSourceId}:{}),...patch};a.data.sources.unshift(source);require('../desktop/protocol-access.cjs').retain(a,'source',source,{actor:'user_command',command:'fixtureImport'});return source;
}
core.Assistant=class extends Base{
 constructor(options){super({...options,chat:async()=>{calls.models++;throw Error('Fixture forbids model calls');},agentRequest:async()=>{calls.requests++;throw Error('Fixture forbids external requests');},connectorRequest:async()=>{calls.messages++;throw Error('Fixture forbids external messages');}});}
 tick(){}
 async dispatch(action,input={}){
  if(action==='fixtureVersionsCounters')return {...calls};
  if(action==='fixtureVersionsNew'){addSource(this,'q4','青禾材料第4版','项目：青禾\r\n预算：7600\r\n负责人：林悦\r\n','qinghe','q3');this.save();return this.publicState();}
  if(action==='fixtureVersionsEqualEdit'){this.data.sources.find(source=>source.id==='q4').content='项目：青禾\r\n预算：7900\r\n负责人：林悦\r\n';this.save();return this.publicState();}
  if(action==='fixtureVersionsDeleted'){this.data.sources.find(source=>source.id==='q4').deleted=input.deleted===true;this.save();return this.publicState();}
  return super.dispatch(action,input);
 }
};
(async()=>{
 const a=new core.Assistant({dir:path.join(dir,'workspace')});await a.dispatch('projectSave',{name:'青禾版本项目'});const project=a.data.projects[0];
 for(const [i,budget]of ['6000','6800','7200'].entries())addSource(a,`q${i+1}`,`青禾材料第${i+1}版`,`项目：青禾\r\n预算：${budget}\r\n负责人：林悦\r\n`,'qinghe',i?`q${i}`:null);
 const t=a.createTask({projectId:project.id,title:'青禾发版说明',sourceIds:['q2','q3'],criteria:'以最新预算为依据',steps:[{title:'核对预算',kind:'draft'}]});t.supersededSourceIds=['q2'];t.needsReplan='预算材料有新版本，需要核对';
 addSource(a,'html1','页面文本旧版','原始说明\n','html');addSource(a,'html2','危险内容按文字显示','原始说明\n<script>window.VERSION_PWNED=true</script>\n<img src=x onerror="window.VERSION_PWNED=true">\n','html','html1');
 addSource(a,'long1','长文材料第1版','A'.repeat(500000),'large');addSource(a,'long2','长文材料第2版','B'.repeat(500000),'large','long1');
 addSource(a,'branch1','分支材料第1版','原始分支\n','branch');addSource(a,'branch2','分支材料第2版','方案一\n','branch','branch1');addSource(a,'branch3','分支材料另一分支','方案二\n','branch','branch1');
 for(let i=1;i<=25;i++)addSource(a,`history${i}`,`历史链第${i}版`,`第${i}版正文\n`,'history',i===1?null:`history${i-1}`);
 for(let i=1;i<=25;i++)a.createTask({projectId:project.id,title:`引用历史链事项${String(i).padStart(2,'0')}`,sourceIds:['history25'],steps:[{title:'检查引用',kind:'analysis'}]});
 a.save();const electron=require('electron');electron.Notification=class{static isSupported(){return false;}on(){}show(){}};electron.dialog.showErrorBox=(title,message)=>{console.error(title,message);electron.app.exit(1);};require('../desktop/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
