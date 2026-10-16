
// Use the same actionable nodes as “待我处理”, not unread activity notifications.
function cards(data,now=Date.now()){return require('./deadline-events.cjs').pendingCards(data,require('./decisions.cjs').cards(data),now);}
function count(data){return cards(data).length;}
function counts(data){
  const nodes=cards(data),review=nodes.filter(card=>card.category==='review').length;
  return {total:nodes.length,progress:nodes.length-review,review};
}
function create({app,tray,Menu,assistant,getCounts,openPending,showMain,openCapture,pause,quit,platform=process.platform}){
  let last=null,scheduled=null,disposed=false;
  function refresh(){
    if(disposed)return;
    const next=getCounts?getCounts():counts(assistant.data);
    if(!next)return;
    if(last&&next.progress===last.progress&&next.review===last.review)return;
    const badge=next.total?String(next.total):'',label=next.total?`待我处理 · ${next.total}`:'暂无待处理事项';
    const title=next.total?`推进 ${next.progress} · 验收 ${next.review}`:'';
    const entries=()=>[
      {label,enabled:next.total>0,click:()=>openPending('all')},
      {label:`推进待介入 · ${next.progress}`,enabled:next.progress>0,click:()=>openPending('progress')},
      {label:`待验收 · ${next.review}`,enabled:next.review>0,click:()=>openPending('review')}
    ];
    if(platform==='darwin'){
      tray.setTitle(title,{fontType:'monospacedDigit'});
      app.dock?.setBadge(badge);
      app.dock?.setMenu(Menu.buildFromTemplate(entries()));
    }
    tray.setToolTip(next.total?`行知助手 · ${next.total} 项需要你处理（推进待介入 ${next.progress} · 待验收 ${next.review}）`:'行知助手 · 暂无待处理事项');
    tray.setContextMenu(Menu.buildFromTemplate([
      ...entries(),{type:'separator'},
      {label:'打开工作台',click:showMain},{label:'快速收集',click:openCapture},
      {label:'暂停自动推进',click:pause},{type:'separator'},{label:'退出',click:quit}
    ]));
    last=next;
  }
  function safelyRefresh(){try{refresh();}catch{/* Retry on the next save/timer; badge failures never interrupt work. */}}
  function schedule(){
    if(disposed||scheduled)return;
    scheduled=setImmediate(()=>{scheduled=null;safelyRefresh();});
  }
  function dispose(){disposed=true;clearImmediate(scheduled);scheduled=null;}
  return {refresh:safelyRefresh,schedule,dispose,count:()=>last?.total??0};
}
module.exports={cards,count,counts,create};
