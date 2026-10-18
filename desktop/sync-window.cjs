// A cursor is consumed only in the same durable commit as its page.
const basis=require('./evidence-basis.cjs');
const stamp=()=>new Date().toISOString();
function scope(c){return basis.hash({id:c.id,provider:c.provider,kind:c.kind,target:c.target,project:c.projectId,credential:c.sealedToken||null,revision:c.permissionRevision||0,...(!c.provider||c.provider==='lark'?{binding:c.larkBinding||null}:{})});}
function begin(c,range){
 const key=scope(c);
 if(c.syncWindow?.scope===key&&c.syncWindow.status==='blocked')throw Object.assign(Error('检测到分页循环，同步断点已保留。请点击同步重新扫描此窗口。'),{connectorCode:'cursor_cycle'});
 if(c.syncWindow?.scope===key&&c.syncWindow.status==='partial')return c.syncWindow;
 return {id:require('node:crypto').randomUUID(),scope:key,range,consumed:[],pages:[],sequence:0,status:'partial',migrated:!!c.cursor?.token};
}
function advance(window,token,result){
 const key=basis.hash(String(token||''));
 if(window.consumed.includes(key))throw Object.assign(Error('检测到分页循环，同步未完成；已保存的材料和断点保留。'),{connectorCode:'cursor_cycle'});
 const next=structuredClone(window);next.consumed.push(key);next.sequence++;
 next.pages.push(basis.hash(result.items));next.status=result.hasMore?'partial':'complete';next.updatedAt=stamp();
 if(result.hasMore&&next.consumed.includes(basis.hash(result.token)))next.status='blocked';
 return next;
}
function restart(c){if(['blocked','expired'].includes(c.syncWindow?.status)){(c.syncWindowHistory ||= []).push(c.syncWindow);c.syncWindow=null;if(c.cursor?.window)delete c.cursor.token;}}
module.exports={begin,advance,restart};
