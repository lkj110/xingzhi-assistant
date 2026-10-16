// Shared navigation for desktop smoke scenarios after the sidebar consolidation.
async function navigate(page,name){
  const groups={
    '工作台':['工作看板','今日安排','工作简报','推进记录'],
    '待我处理':['待我决策','成果验收','关注中心'],
    'Agent 委托':['Agent 委托','工作规则','工作方案'],
    '信息收集':['信息收件箱','信息连接','收集队列','材料归类'],
    '项目':['项目','项目工作地图','工作记忆'],
    '工作产出':['工作产出'],'全局检索':['全局检索'],
    '模型与设置':['模型与设置','运行与恢复','工作体检'],
  };
  const filters={'已完成事项':'completed','已暂停事项':'paused','需要关注':'attention','待我验收':'review'};
  const target=filters[name]?'工作看板':name;
  const group=Object.keys(groups).find(key=>key===target||groups[key].includes(target));
  if(!group)throw Error('Unknown navigation: '+name);
  await page.locator('.sidebar').getByRole('button',{name:group,exact:true}).click();
  if(target!==group&&groups[group][0]!==target){
    const label={'关注中心':'关注提醒','项目工作地图':'工作地图'}[target]||target;
    await page.getByRole('navigation',{name:group+'二级导航',exact:true}).getByRole('button',{name:label,exact:true}).click();
  }
  if(filters[name])await page.getByLabel('筛选事项',{exact:true}).selectOption(filters[name]);
}
module.exports={navigate};
