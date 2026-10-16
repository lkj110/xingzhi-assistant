import React from 'react';
import {LayoutDashboard, ShieldCheck, Bot, Inbox, FolderOpen, FileText, Search, Settings2} from 'lucide-react';
import './navigation.css';

export const workspaceSections = [
  {id:'work',label:'工作台',icon:LayoutDashboard,pages:[['board','工作看板'],['operations','今日安排'],['briefing','工作简报'],['activity','推进记录'],['trash','已删除']]},
  {id:'decide',label:'待我处理',icon:ShieldCheck,pages:[['decisions','待我决策'],['acceptance','成果验收'],['attention','关注提醒']]},
  {id:'delegate',label:'Agent 委托',icon:Bot,pages:[['agent','委托列表'],['rules','工作规则'],['playbooks','工作方案']]},
  {id:'collect',label:'信息收集',icon:Inbox,pages:[['inbox','信息收件箱'],['connections','信息连接'],['capture','收集队列'],['routing','材料归类']]},
  {id:'project',label:'项目',icon:FolderOpen,pages:[['projects','全部项目'],['workmap','工作地图'],['memory','工作记忆']]},
  {id:'results',label:'工作产出',icon:FileText,pages:[['artifacts','当前成果']]},
  {id:'search',label:'全局检索',icon:Search,utility:true,pages:[['library','全局检索']]},
  {id:'settings',label:'模型与设置',icon:Settings2,utility:true,pages:[['settings','模型配置'],['capabilities','能力中心'],['runtime','运行与恢复'],['health','工作体检'],['help','使用说明']]},
];

export function sectionForPage(page){
  return workspaceSections.find(section=>section.pages.some(([target])=>target===page));
}

export function WorkspaceNavigation({page,counts,onNavigate,utility=false}){
  const current=sectionForPage(page);
  return <nav aria-label={utility?'工具与设置':'工作空间导航'}>{workspaceSections.filter(s=>!!s.utility===utility).map(section=>{
    const Icon=section.icon,count=counts[section.pages[0][0]]||0;
    return <button key={section.id} className={current?.id===section.id?'active':''} aria-current={current?.id===section.id?'page':undefined} aria-label={section.label} title={section.pages.map(([,label])=>label).join(' · ')} onClick={()=>onNavigate(section.pages[0][0])}><Icon/>{section.label}{count>0&&<span className={section.id==='decide'?'count-green':undefined} aria-hidden="true">{count}</span>}</button>;
  })}</nav>;
}

export function SectionNavigation({page,counts,onNavigate}){
  const section=sectionForPage(page);
  if(!section||section.pages.length<2)return null;
  return <nav className="section-navigation" aria-label={`${section.label}二级导航`}>{section.pages.map(([target,label])=><button key={target} className={page===target?'active':''} aria-current={page===target?'page':undefined} aria-label={label} onClick={()=>onNavigate(target)}>{label}{counts[target]>0&&<span aria-hidden="true">{counts[target]}</span>}</button>)}</nav>;
}
