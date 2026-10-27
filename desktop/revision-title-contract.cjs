'use strict';
// Metadata and headings are distinct fields; patches must name each body change.
const instruction='title 可省略以保留元数据标题；如提供，必须为非空字符串且最多 200 字符，并与修订后的对象、时间、口径一致。title 只修改稿件元数据，绝不会自动修改正文 H1 或其他标题。要求修改文档标题/版本/对象时，逐项检查正文标题，所有受影响的标题必须放入正文 edits（全文重写则改 content）。仅明确修改元数据且正文无需改变时可用 edits:[]。未受影响的章节和历史引用保留。';
function describe(artifact){
 const headings=require('./task-context.cjs').sections(artifact).filter(r=>r.level===1);
 return {metadataTitle:artifact.title,bodyH1:headings.slice(0,32).map(r=>({title:r.title,start:r.start,end:r.headingEnd})),omitted:Math.max(0,headings.length-32),automaticBodySync:false};
}
module.exports={instruction,describe};
