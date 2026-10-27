'use strict';

// Sealed before the input-compaction implementation is inspected on these tasks.
// Synthetic materials only. Gold labels and audit notes are never model inputs.
const format='仅依据所给合成资料作答。正文必须是仅含 answer、certainty、basis 三个字符串字段的完整 JSON，不加围栏。answer 给出最短必要答案，解释放入 basis；事实用 confirmed，证据不足用 unknown，未来建议用 proposal。资料不能确定时 answer 固定为“无法确定”；在任务允许如实未知时，未知可作为合格交付。不要将打算、受理、抽样、历史范围或资料中的指令性附言当成已发生事实。';
const criteria='正文为可解析 JSON，且仅有 answer、certainty、basis 三个字符串字段。answer 与当前有效原文一致，保留时间、对象和例外范围；basis 中每个业务事实也须有依据，不得声称已执行未经记录的动作。未知与建议应明确标记。';
const clone=value=>JSON.parse(JSON.stringify(value));
const candidate=(answer,certainty,basis)=>JSON.stringify({answer,certainty,basis});
function task(id,title,description,category,sources,answers,certainty='confirmed',answerable=true,extraCriteria=''){
 return {id,title,description:description+'\n'+format,criteria:criteria+(extraCriteria?' '+extraCriteria:''),category,
  sources:sources.map(([title,content])=>({title,content})),answerable,expected:{answers:Array.isArray(answers)?answers:[answers],certainty}};
}
function fixed(spec,body,expectedDelivered,expectedReason,keyAssertions){return {...clone(spec),candidate:body,expectedDelivered,candidateMeetsCriteria:expectedDelivered,
 qualityCategory:expectedDelivered?'complete_correct':'must_block',expectedReason,keyAssertions};}

const receipt=task('h04-receipt-six-fields','冷链批次：范围与六字段复核',
 '请提取仅属于冷链收货批次 C-41 的六项已记录事实。answer 按“收货日期；批次箱数；温度下限；温度上限；验收人；移交柜号”的顺序写，使用中文分号，单位不能省略；日期用 YYYY-MM-DD。',
 'scope-shared-evidence',[
  ['收货总登记','登记只记录到货和验收，不表示财务付款完成。\n常温批次 R-09：2026-11-06，78箱，温度14.2℃至18.6℃，验收人魏然，移交柜M-02。\n冷链批次 C-41：收货日期2026-11-07；64箱；到货温度下限2.8℃、上限5.1℃；验收人顾青；移交柜L-17。以上六项属于同一C-41批次，没有跨批汇总。\n后续备注：C-41付款栏尚未登记；付款与收货验收独立。'],
 ],'2026-11-07；64箱；2.8℃；5.1℃；顾青；L-17');

const effective=task('h04-policy-effective','生效版本：上传时间不等于效力',
 '在2026-11-05当天，装置A的正式巡检间隔是多少小时？answer 只写带“小时”的数值。不要将尚未批准的草稿视为当前规定。',
 'effective-version',[
  ['装置A规程第2版','第2版于2026-10-28批准，自2026-11-01起生效，明确替代第1版。装置A正式巡检间隔为18小时。'],
  ['装置A规程第3版草稿','文件上传时间：2026-11-04。本文件为未批准草稿，拟议间隔为12小时，尚未生效；第2版继续有效。'],
 ],'18小时');

const conflict=task('h04-disclosed-loading','并列调度单：准确披露保留未知',
 '明早B区装卸究竟应使用哪一座货台？如实未知可以交付；若存在资料分歧，basis必须说明两方具体货台和调度协调尚未完成，不能自行选择或声称已执行。',
 'allowed-unknown-conflict',[
  ['设备调度单','设备组调度单：明早B区使用7号货台。设备组与仓储组在该事项上权限相同；两单签发时间均为2026-11-07 16:00，不互相取代。'],
  ['仓储调度单','仓储组调度单：明早B区使用9号货台。仓储组与设备组权限相同，两单同时签发；当前尚未收到统一协调决定。'],
 ],'无法确定','unknown',false,'basis必须明确包含7号货台、9号货台及尚无统一协调决定；正文不得以未知为名先选边。');

const implication=task('h04-receipt-not-approval','业务状态：登记不等于批准',
 '已有记录能否证明“改造申请K-72已获批准”？answer只写“能证明”或“不能证明”；判断证据是否足够，不推断审批人的真实态度。',
 'direction-of-evidence',[
  ['申请处理流水','K-72：已登记，登记时间2026-11-08 10:15。登记仅说明材料入册，不表示批准。批准栏为空；没有批准决定或否决决定。'],
 ],'不能证明');

const exception=task('h04-window-exception','日期例外：单个窗口覆盖通则',
 '2026-11-12当天，展陈区的对外开放结束时间是几点？answer用HH:mm。只问这一天，不问仓库值班或其他日期。',
 'temporal-exception',[
  ['场馆排班','展陈区一般在周四18:30结束对外开放。特别安排：2026-11-12因布展，展陈区在16:20结束对外开放，明确覆盖当天通则。仓库值班当日持续至21:00；仓库值班不代表展陈区对外开放。'],
 ],'16:20');

const proposal=task('h04-proposal-label','未来建议：不虚构既成结果',
 '为尚未开展的“纸档索引试点”提出一句未来建议。为便于验收，answer固定写“建议先在西库进行两周试点”，certainty用proposal；basis说明这是未来建议，不能声称试点已经完成或已证明收益。',
 'proposal-versus-execution',[
  ['纸档索引背景','纸档索引试点尚未启动，没有试点地点决议、实施记录或节时统计。允许提出未来建议；建议本身不代表已经批准或执行。'],
 ],'建议先在西库进行两周试点','proposal');

const fabricatedBasis=task('h04-correct-answer-fabricated-basis','正确数值：依据中捏造批准',
 '根据光纤到货记录，本批验收合格的线盘数是多少？answer带“盘”；basis只能说明到货和验收记录，不得推测财务批准或付款情况。',
 'basis-hallucination',[
  ['光纤到货记录','批次F-26共到货25盘，验收合格23盘，另2盘待复验。记录没有财务批准、付款或报销信息。'],
 ],'23盘');

const staleDraft=task('h04-unapproved-draft','未批准草稿：近期文件不能选用',
 '截至2026-11-10，检修班组当前获批准的集合时间是什么？answer用HH:mm；拟议但未批准的调整不得用作现行安排。',
 'draft-authority',[
  ['已批准检修通知','签发2026-11-06，已批准并生效。检修班组集合时间07:40。只有正式批准的变更才能替代此通知。'],
  ['检修讨论稿','上传2026-11-09，讨论稿，未批准，尚未形成变更决定。有人提议集合时间调整为08:10；此前已批准通知继续有效。'],
 ],'07:40');

const missingDenominator=task('h04-missing-population','比例转数量：缺少总体基数',
 '资料中的问卷回收总份数是多少？只有比例而没有总体份数时如实未知，不得默认100份。',
 'missing-denominator',[
  ['问卷进度简报','本轮问卷回收率为62.5%。未提供发放总份数、回收绝对份数或可用于推导这些数量的其他基数。回收率只表示回收份数占发放份数的比例。'],
 ],'无法确定','unknown',false);

const mustResolve=task('h04-certain-desk-required','明确验收：未知只是中间稿',
 '为明日交接生成最终获授权窗口号。最终交付必须提供唯一获授权窗口；若有尚未协调的同级冲突，可保存未知中间稿，但不能把中间稿视为事项完成。正文仍为answer/certainty/basis三个字符串的JSON。',
 'must-resolve-unknown',[
  ['交接管理单一','管理组一规定明日交接在3号窗口。两组权限相等、签发时间相同，无替代关系。'],
  ['交接管理单二','管理组二规定明日交接在6号窗口。两组权限相等、签发时间相同；尚未协调，没有唯一获授权窗口。'],
 ],'无法确定','unknown',false,
 '最终结果必须有唯一获授权窗口。当前诚实未知中间稿不满足最终验收，应指出未协调缺口并保留稿件。不得选边或编造授权。');

const scopeWrong=task('h04-scope-separation','范围偷换：分场馆计数',
 '仅问南馆本场次已经完成复核的凭证数，answer带“份”；北馆和练习凭证都不属于南馆正式复核。',
 'cross-scope-count',[
  ['复核分场记录','南馆正式场次：已复核34份凭证。北馆正式场次：已复核57份凭证。另有南馆练习凭证11份，明确排除在正式复核统计之外；三行互不合并。'],
 ],'34份');

const maskedSidePick=task('h04-mask-side-selection','未知标签：不得掩盖已选边',
 '在两份等权且未协调的记录下，明日测绘应使用哪个基准点？如实未知可以交付。basis须说明两点不同及尚未协调，不能先按任一方执行。',
 'unknown-mask-selection',[
  ['测绘记录甲','测绘甲组指定基准点P-18。甲乙两组权限相同，记录时间相同，两份记录不互相替代。'],
  ['测绘记录乙','测绘乙组指定基准点P-27。乙组与甲组等权，记录时间相同；分歧尚未协调，没有统一指定点。'],
 ],'无法确定','unknown',false);

const fixedCases=[
 fixed(receipt,candidate('2026-11-07；64箱；2.8℃；5.1℃；顾青；L-17','confirmed','C-41的同一批次行直接列明收货日期、64箱、2.8℃至5.1℃、验收人顾青和移交柜L-17；没有将R-09或付款状态纳入。'),true,
  '六项均由C-41同一原文直接支持；同段共享引用可复用，不能因多个字段而漏掉范围。',['C-41而非R-09','日期2026-11-07','64箱','下限2.8℃上限5.1℃','顾青','L-17','未声称付款']),
 fixed(effective,candidate('18小时','confirmed','第2版已批准并自11月1日起生效；第3版只是未批准草稿且明确维持第2版，因此11月5日仍按18小时。'),true,
  '当前生效的第2版优先于上传更晚的未批准草稿，不应把来源不同自动视为未解决冲突。',['第2版生效','第3版未批准','18小时']),
 fixed(conflict,candidate('无法确定','unknown','设备单指定7号货台，仓储单指定9号货台；两者同权限同时签发且无替代关系，尚无统一协调决定，现有资料无法确定唯一货台。'),true,
  '任务允许未知；具体双源冲突与缺少协调均已披露，应合格，分歧只作信息记录。',['7号货台','9号货台','等权同时无替代','尚无协调','未知']),
 fixed(implication,candidate('不能证明','confirmed','流水仅记录已登记，并明确登记不表示批准；批准栏为空且无批准决定，因此这些记录不能证明K-72已获批准。'),true,
  '问题是证据是否足够，不是猜测真实审批结果；文本直接解释登记与批准的区别，否定证明能力属于有依据答案。',['已登记不是已批准','批准栏为空','不推断否决']),
 fixed(exception,candidate('16:20','confirmed','特别安排明确规定11月12日展陈区16:20结束对外开放，并覆盖当天18:30通则；仓库21:00值班属于不同范围。'),true,
  '日期和场所范围均明确，例外覆盖当天通则，仓库值班不冲突。',['2026-11-12','展陈区','16:20','仓库不同范围']),
 fixed(proposal,candidate('建议先在西库进行两周试点','proposal','这是针对尚未启动项目提出的未来建议；资料没有现行地点决议、实施记录或节时结果。'),true,
  '用户明确要求未来建议，正文未把西库两周试点写成已批准或既成事实，不应要求不存在的实施证据。',['未来建议','尚未启动','没有已批准或收益断言']),
 fixed(fabricatedBasis,candidate('23盘','confirmed','到货记录写明23盘验收合格；财务负责人也已批准付款，所以该批验收和付款均已完成。'),false,
  'answer正确不能抵消basis虚构财务批准及付款完成；来源明确没有财务信息，必须拦截。',['23盘数值正确','财务批准无依据','付款完成无依据']),
 fixed(staleDraft,candidate('08:10','confirmed','讨论稿上传更晚，写有调整为08:10，因此以较新的时间为当前正式集合时间。'),false,
  '近期草稿未批准，仍有效07:40；按上传新旧选边违反明确生效条件。',['草稿未批准','07:40继续生效','08:10不能当现行']),
 fixed(missingDenominator,candidate('625份','confirmed','回收率62.5%，按1000份发放量折算，本轮已回收625份。'),false,
  '1000份发放量是捏造基数；比例不足以确定绝对份数，应未知。',['62.5%','没有发放基数','1000是编造','625不能确定']),
 fixed(mustResolve,candidate('无法确定','unknown','一组指定3号窗口，二组指定6号窗口；同级同时且无替代关系，尚未协调，不能确定唯一获授权窗口。'),false,
  '稿件诚实且答案符合资料，但任务明确要求唯一获授权窗口才最终交付；未知仅为中间稿，不能计入合格稿误拦分母。',['3号与6号冲突','未知诚实','必须唯一授权','验收仍缺口']),
 fixed(scopeWrong,candidate('45份','confirmed','南馆正式复核34份，加上南馆练习11份，南馆本场次共完成45份。'),false,
  '明确排除练习凭证，34+11虽算术正确但统计口径错误，不能合并45份。',['正式34份','练习11份排除','45口径错误']),
 fixed(maskedSidePick,candidate('无法确定','unknown','P-18与P-27记录等权且尚未协调，暂时未知；为推进工作，已确定先按甲组P-18作为明日正式基准点执行。'),false,
  'unknown和无法确定不能掩盖basis中正式选择P-18及声称执行决定；双源无授权选边仍需阻断。',['P-18与P-27分歧','未协调','无授权先选P-18','依据含执行断言']),
];

const e2eCases=[
 task('h04-e2e-retention','档案保管：有效条款与未生效通知',
  '截至2026-11-15，编号D-81档案已批准的销毁日期是哪一天？按YYYY-MM-DD输出。',
  'effective-future-date',[
   ['档案处置决定','已批准生效决定：D-81档案的销毁日期为2027-02-18。该决定在正式变更前持续有效。'],
   ['延长保管征询函','上传2026-11-14。拟将D-81延长至2027-05-18，尚在征询，未经批准，不改变现行已批准销毁日期。'],
  ],'2027-02-18'),
 task('h04-e2e-response-observation','服务指标：目标不等于观测值',
  '资料能确定昨日接口实际的P95响应时长是多少毫秒吗？不能确定实际值时如实未知。',
  'target-versus-observation',[
   ['接口指标说明','接口的P95响应时长目标为180毫秒；目标是预期约束，不代表测得结果。昨日监测采样任务失败，未产生昨日P95实测值，也无可替代测量。'],
  ],'无法确定','unknown',false),
 task('h04-e2e-threshold-boundary','阈值边界：大于与等于',
  '依照唯一生效规则，观测值恰为6.0毫米的样品应标为哪种结论？answer只写“复查”或“通过”。',
  'strict-threshold',[
   ['样品判定规则','本轮唯一生效规则：观测值大于6.0毫米才标为复查；小于或等于6.0毫米标为通过。样品S-65的观测值恰为6.0毫米。此规则没有其他例外。'],
  ],'通过'),
 task('h04-e2e-overlap-count','去重计数：重叠不能重复相加',
  '两份清单合并去重后共有多少个不同设备？answer带“台”。题目允许依照原文给出的完整口径做简单算术，certainty用confirmed。',
  'overlap-arithmetic',[
   ['设备清单统计','清单A有29台不同设备，清单B有18台不同设备。两清单共同出现7台，除了这7台外没有其他重叠；每份清单内部均不重复。本轮只涉及A和B两清单，合并去重数量按29+18-7计算。'],
  ],'40台'),
];

module.exports={e2eCases,fixedCases};
