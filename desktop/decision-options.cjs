const crypto=require('node:crypto');
const clean=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const prompt=`需要用户补充才能推进时，把缺口整理成一个明确问题 question，尽量控制在 120 字内，只问用户需要决定的事情；用 context 简短解释为什么需要回答，具体细节放在 context。尽量给出 2–3 个互斥、贴合当前事项的 options，每项为 {"label":"简短方案名称","description":"适用条件及对推进的影响","answer":"选择后交给 Agent 的完整决定","recommended":true或false,"requiresText":false}。只推荐其中一个并在 description 说明理由。日期、负责人、金额等未知事实不能编造选项，可改为提供材料、只推进有证据部分等补充方式；需用户补充具体内容的选项 requiresText=true。没有足够依据时可以省略 options，由应用提供补充方式。应用始终另外提供“自行填写”，不需要在 options 中重复生成；推荐不是批准，等待用户明确提交。涉及权限使用授权入口，不将选项或自由文本当作已取得凭据、执行回执或预算批准。`;
function normalize(value,suggestion=''){
  const options=[];
  for(const raw of Array.isArray(value)?value:[]){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    const label=clean(raw.label,100),description=clean(raw.description,600),answer=clean(raw.answer,2000)||label;
    if(!label||!description||/^(?:其他|其它|自行填写|自定义|other|custom)(?:[（(].*)?$/i.test(label)||options.some(o=>o.label===label||o.answer===answer))continue;
    const option={label,description,answer,requiresText:raw.requiresText===true,recommended:raw.recommended===true};
    option.id='option-'+digest([label,description,answer,option.requiresText]).slice(0,16);options.push(option);if(options.length===3)break;
  }
  if(options.length<2){
    const suggested=clean(suggestion,2000);
    return normalize([
      ...(suggested?[{label:'采用助手建议',description:suggested.slice(0,600),answer:suggested,recommended:true}]:[]),
      {label:'补充关键信息',description:'提供已确认的事实、链接或材料，补齐缺口后按原要求推进。',answer:'请结合我补充的已确认信息继续推进。',requiresText:true,recommended:!suggested},
      ...(!suggested?[{label:'先推进可确认的部分',description:'先检查是否有不依赖缺失信息的工作；缺口仍保留，不把假设当作事实。',answer:'先评估并推进已有证据支持、且不依赖缺失信息的部分。保留原完成标准，未补齐的关键缺口明确标注，不能因此宣称完整完成。'}]:[])
    ]);
  }
  const recommended=options.findIndex(o=>o.recommended);options.forEach((o,i)=>o.recommended=i===(recommended<0?0:recommended));
  return options.sort((a,b)=>Number(b.recommended)-Number(a.recommended));
}
function present(d){return {...d,context:clean(d.context,1500),options:normalize(d.options,d.suggestion),allowCustom:true};}
function answer(d,input){
  const supplied=typeof input.answer==='string'?input.answer.trim():'';
  if(supplied.length>3000)throw Error('补充内容不能超过 3000 字符');
  if(!input.optionId||input.optionId==='custom'){
    if(!supplied)throw Error('请填写你的回答');
    return {answer:supplied,selectedOption:null,answerMode:'custom',answerNote:supplied};
  }
  const option=normalize(d.options,d.suggestion).find(o=>o.id===input.optionId);
  if(!option)throw Error('所选方案已变化，请重新选择');
  if(option.requiresText&&!supplied)throw Error('请补充此方案需要的具体信息');
  return {answer:option.answer+(supplied?`\n补充说明：${supplied}`:''),selectedOption:{...option},answerMode:'option',answerNote:supplied};
}
module.exports={normalize,present,answer,prompt};
