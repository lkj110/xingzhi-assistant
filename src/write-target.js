export function actionTarget(record) {
  const target=String(record?.target || '');
  if(record?.tool==='lark_update')return record.baseline?.url||record.result?.url||'此事项已有飞书文档';
  if(record?.tool==='lark_create')return target==='my_library'?'本人飞书云文档':`飞书文件夹 ${target.replace(/^folder:/,'')}`;
  return record?.tool==='write_file'&&record.latestName ? target.replace(/[^/\\]+$/,()=>record.latestName) : target;
}
