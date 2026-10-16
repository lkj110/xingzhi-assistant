import React,{useState} from 'react';
export default function QuestionAnswer({question,context,options=[],busy=false,stale=false,onSubmit,submitLabel='保存决定并继续',labelForOption}){
  const [selected,setSelected]=useState(''),[note,setNote]=useState(''),[customOption,setCustomOption]=useState('custom');
  const readyOptions=options.filter(o=>!o.requiresText),textOptions=options.filter(o=>o.requiresText);
  const custom=selected==='custom',answerOption=custom?customOption:selected;
  const missing=!!selected&&(custom?customOption!=='custom'&&!textOptions.some(o=>o.id===customOption):!readyOptions.some(o=>o.id===selected));
  return <form className="question-answer" onSubmit={e=>{e.preventDefault();if(!busy&&!stale&&!missing&&selected&&(!custom||note.trim()))onSubmit({optionId:answerOption,answer:custom?note:''});}}>
    {context&&<p className="question-context">{context}</p>}
    <fieldset disabled={busy||stale}><legend>选择一种处理方式</legend>
      {readyOptions.map(o=><label className={`question-option ${selected===o.id?'selected':''}`} key={o.id}><input type="radio" name={`question-${question}`} checked={selected===o.id} onChange={()=>setSelected(o.id)}/><span><strong>{o.label}{o.recommended&&<em>推荐</em>}</strong><small>{o.description}</small></span></label>)}
      <label className={`question-option ${custom?'selected':''}`}><input type="radio" name={`question-${question}`} checked={custom} onChange={()=>setSelected('custom')}/><span><strong>自行填写{textOptions.some(o=>o.recommended)&&<em>推荐</em>}</strong><small>提供具体材料、补充事实，或提出其他处理方案。</small></span></label>
    </fieldset>
    {missing&&<p className="form-error" role="alert">原方案已变化，请重新选择；补充文字已保留。</p>}
    {custom&&<>{textOptions.length>0&&<label>补充方式<select aria-label="补充方式" value={customOption} disabled={busy||stale} onChange={e=>setCustomOption(e.target.value)}><option value="custom">自行说明</option>{textOptions.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select>{textOptions.find(o=>o.id===customOption)?.description&&<small>{textOptions.find(o=>o.id===customOption).description}</small>}</label>}<label>请补充具体内容<textarea aria-label={`回答：${question}`} rows={3} maxLength={3000} value={note} required disabled={busy||stale} onChange={e=>setNote(e.target.value)} placeholder="填写具体事实、材料或你的处理方案"/></label></>}
    <button className="button primary" disabled={busy||stale||missing||!selected||(custom&&!note.trim())}>{labelForOption?.(answerOption)||submitLabel}</button>
    <small className="question-submit-note">选择推荐项后仍需点击按钮确认；回答将保存到原事项。</small>
  </form>;
}
