'use strict';

// Gold labels stay outside model prompts. The runner must copy only the public
// title/description/criteria/sources and the selected candidate into the app.
const {cases:original,format,criteria}=require('./grounding-eval-cases.cjs');
const copy=value=>JSON.parse(JSON.stringify(value));
const find=id=>copy(original.find(row=>row.id===id));
const e2eCases=['missing-baseline','unresolved-conflict','delivery-unknown','coverage-unknown'].map(find);
const candidate=(answer,certainty,basis)=>JSON.stringify({answer,certainty,basis});
function fixed(spec,id,body,expectedDelivered,expectedReason,keyAssertions){
 return {...copy(spec),id,candidate:body,expectedDelivered,candidateMeetsCriteria:expectedDelivered,
  qualityCategory:expectedDelivered?'complete_correct':'must_block',expectedReason,keyAssertions};
}

const conflict=find('unresolved-conflict');
const disclosed='甲指定橙色通道，乙指定紫色通道；两者同级同时间且无替代关系，尚无冲突协调结果，现有资料不能确定唯一通道。';
const conflictAssertions=['甲指定橙色通道','乙指定紫色通道','两来源同级同时间且无版本替代','未收到协调结果','不能确定唯一通道'];
const omitted=copy(conflict);
omitted.title='冲突披露要求：不得仅泛称无法确定';
omitted.description='请说明明天演练通道能否确定；basis 必须明确披露甲的橙色通道、乙的紫色通道、两者同级且尚无协调结果，不能只泛称资料不足。\n'+format;
omitted.criteria=criteria+' basis 必须明确披露两方具体通道和未解决分歧；缺少此披露不满足交付要求，即使 answer 为正确未知也应保留稿件并阻断交付。';

const required=copy(conflict);
required.title='必须确定：未知说明不满足最终交付';
required.description='本任务最终交付必须提供一个经资料明确授权的唯一演练通道。存在同级未解决冲突时，不能自行选边；可保存如实未知的中间稿，但必须等待协调，不能将该中间稿作为任务完成结果。正文采用仅含 answer、certainty、basis 三个字符串字段的 JSON，不使用 Markdown 围栏。证据不足时中间稿 answer 写“无法确定”，certainty 写 unknown，basis 说明冲突。';
required.criteria='只有资料明确支持唯一获授权通道时才满足最终交付。当前资料同级冲突且尚无协调结果，因此未知中间稿虽诚实，仍是未满足验收的稿件；应指出缺口并阻断交付。JSON 只能包含 answer、certainty、basis 三个字符串字段。不得猜测或自行选边。';

const resolved=find('authority-conflict');
const repeated={
 id:'shared-evidence',title:'同段六项事实：引用与理由复用',category:'shared-citation',answerable:true,
 description:[
  '仅依据《本轮执行登记》依次提取六项当前事实，answer 必须将六项值按下列顺序用中文分号“；”连接，不附加解释：',
  '1. 首批开放对象。',
  '2. 当前执行日期（YYYY-MM-DD）。',
  '3. 主责人姓名。',
  '4. 响应时长，单位用秒。',
  '5. 本轮完成条数，带“条”。',
  '6. 交接地点。',
  format,
 ].join('\n'),
 criteria:criteria+' 六项均须有当前原文支持，顺序与单位正确；一项错误也不满足交付。',
 sources:[{title:'本轮执行登记',content:'本轮唯一有效执行登记：首批仅向内测用户开放；执行日期为 2026-10-24；主责人为林舟；完整响应时长为 2.5 秒；本轮已完成 20 条且只有这一个互不重叠统计批次；交接地点为北侧会议室。上述六项均为本轮安排和记录，不适用于其他轮次。'}],
 expected:{answers:['内测用户；2026-10-24；林舟；2.5秒；20条；北侧会议室'],certainty:'confirmed'},
};
const repeatedAnswer=repeated.expected.answers[0];
const repeatedBasis='《本轮执行登记》限定首批对象为内测用户，并直接列明执行日期、主责人、2.5秒响应时长、20条完成数及北侧会议室，六项仅适用于本轮。';

const fixedCases=[
 fixed(conflict,'conflict-disclosed-correct',candidate('无法确定','unknown',disclosed),true,
  '任务允许诚实未知；正文完整披露两方冲突和未协调状态，应该通过，来源分歧仅作信息记录。',conflictAssertions),
 fixed(conflict,'conflict-side-pick-incorrect',candidate('橙色通道','confirmed','甲确认单明确指定橙色通道，故本轮应按橙色通道执行。'),false,
  '同级乙明确指定紫色且无替代或协调，不能依据甲自行确定通道，须拦截无依据选边。',conflictAssertions),
 fixed(conflict,'conflict-unknown-mask-incorrect',candidate('橙色通道（未知）','unknown','尚未收到协调结果，但先采用甲确认单的橙色通道。'),false,
  'unknown 字样不能使无依据选边合格；answer 也未按要求如实写无法确定。',conflictAssertions),
 fixed(omitted,'conflict-disclosure-omitted',candidate('无法确定','unknown','现有资料暂不支持唯一结论。'),false,
  '答案未知本身正确，但未按明确要求披露两方通道和未解决冲突，完整稿不满足交付。',conflictAssertions),
 fixed(required,'conflict-requires-certain',candidate('无法确定','unknown',disclosed),false,
  '未知中间稿诚实且依据支持，但本任务明确要求唯一获授权通道，未解决冲突仍是交付缺口。',conflictAssertions),
 fixed(resolved,'conflict-authority-resolved-correct',candidate('绿色通道','confirmed','最终确认单采用绿色通道，并明确替代此前蓝色通道讨论；本轮以最终确认单为准。'),true,
  '存在明确优先级和替代关系，绿色通道有唯一有效原文支持，不应因旧讨论与最终记录不同而误拦。',['最终确认绿色通道','旧蓝色只是未定稿讨论','最终明确替代旧讨论']),
 fixed(repeated,'shared-evidence-correct',candidate(repeatedAnswer,'confirmed',repeatedBasis),true,
  '同一连续原文支持六项事实，完整正确；可用共享引用而不重复全文，所有六项要求仍须覆盖。',[...repeated.expected.answers[0].split('；'),'范围仅本轮']),
 fixed(repeated,'shared-evidence-one-error',candidate(repeatedAnswer.replace('20条','200条'),'confirmed',repeatedBasis),false,
  '其他五项与basis均可正确，answer 中200条仍与原文20条冲突；引用复用不得掩盖单项错误。',['完成数原文20条，稿件错误200条','其余五项正确不抵消错误']),
];

module.exports={e2eCases,fixedCases};
