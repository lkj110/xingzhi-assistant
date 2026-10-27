'use strict';
// Instructions for the independent semantic checker; deliberately no natural-
// language heuristic can turn an unsupported statement into a local pass.
const instruction='fact包括直接陈述、同义复述及全部已读前提必然蕴含的结论：保持对象、范围、时间、数量、条件和确定性，引用全部必要前提；只换措辞不算推理。直接蕴含不需额外写“推断”，但须反查是否偷加同一主体、资源排他、无例外等假设；前提有歧义、缺失或冲突时不能按fact放行。需要额外假设、解释、预测或因果判断用inference，保留不确定性并引前提；未知/建议须明示。inference的限定可由同一段或记录内明确呈现的前提、推理关系及适用边界表达，用qualification绑定完整作用域，不强制固定词“推断”；仅罗列前提不能替代必要的不确定性限定。supported评价整个结论的证据及适用边界，不因缺少某个固定提示词而判无支持；依据不足、过度确定或无法核实仍须false。';
module.exports={instruction};
