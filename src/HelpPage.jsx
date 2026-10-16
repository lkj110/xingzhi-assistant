import {version} from '../package.json';
import React, {useMemo, useRef, useState} from 'react';
import {ArrowRight, BookOpen, Check, Download, Inbox, Search, ShieldCheck, Sparkles, X} from 'lucide-react';
import Markdown from './Markdown';
import {CapturePermissions} from './QuickCaptureWindow';
import {download} from './api';
import guide from '../docs/USER_GUIDE.md?raw';
import {guideRoutes, parseGuide, searchGuide} from './help-content.mjs';
import './help.css';

const sections = parseGuide(guide);

export function QuickStartDialog({Modal, hasModels, onDismiss}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function finish(target) {
    if (busy) return;
    setBusy(true); setError('');
    try { await onDismiss(target); }
    catch (error) { setError(`未能保存上手状态：${error.message}。请重试。`); }
    finally { setBusy(false); }
  }
  const steps = [
    {icon: Sparkles, title: '连接你的模型', text: '支持当前 Codex 订阅、兼容接口和本地 Ollama。三个角色可以先用同一个模型。', hint: hasModels ? '已为三个角色选择模型' : '从「模型与设置」开始'},
    {icon: Inbox, title: '贴一段话，创建事项', text: '点击「新建事项」或「快速收集」，粘贴文字或截图。Agent 自动整理标题、背景和目标，创建后就开始推进。', hint: '例如：把会议记录整理成一页周报'},
    {icon: ArrowRight, title: '让 Agent 持续推进', text: '选中文字或截图后，可新建事项，也可补充到正在推进的事项。先看关联推荐，再确认目标；需要作决定时到「待我处理」，选择推荐方案或自行填写。', hint: '后续可接入自动收集和 DW 等能力'},
    {icon: ShieldCheck, title: '阅读成果并验收', text: '到「工作产出」先看当前成果。不符合要求就提出修改，让原 Agent 继续。', hint: '模型、用量和费用在每轮运行记录里'},
  ];
  return <Modal wide title="欢迎使用行知助手" subtitle="先完成一件小事，再把日常工作交给助手。" onClose={() => finish()}>
    <div className="modal-body quickstart-body">
      <div className="quickstart-intro"><BookOpen size={21}/><p>从材料到结果，你只需交代目标、补充必要信息，并确认最终成果。</p></div>
      <CapturePermissions/>
      <ol className="quickstart-steps">{steps.map((step, index) => <li key={step.title}>
        <div className="quickstart-number">{index + 1}</div><div><h3><step.icon size={17}/>{step.title}</h3><p>{step.text}</p><small>{index === 0 && hasModels && <Check size={13}/>} {step.hint}</small></div>
      </li>)}</ol>
      <p className="quickstart-note">本说明不会启动任务。模型调用按你的配置使用额度；一次推进全过程默认共用 $100 等值上限，需要你确认才会增加。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer quickstart-footer">
      <div><button className="text-button" disabled={busy} onClick={() => finish()}>暂时跳过</button><small>以后可从顶部「使用说明」重新打开</small></div>
      <button className="button" disabled={busy} onClick={() => finish('help')}><BookOpen size={15}/>完整功能说明</button>
      <button className="button primary" disabled={busy} onClick={() => finish(hasModels ? 'captureWindow' : 'settings')}>{busy ? '保存中…' : hasModels ? '记录第一件事' : '先连接模型'}<ArrowRight size={15}/></button>
    </footer>
  </Modal>;
}

export default function HelpPage({onNavigate, onReplay}) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(sections[0].id);
  const article = useRef();
  const found = useMemo(() => searchGuide(sections, query), [query]);
  const current = found.find(section => section.id === selected) || found[0];
  const currentIndex = sections.findIndex(section => section.id === current?.id);
  const route = guideRoutes[current?.id];
  function choose(id) { setSelected(id); article.current?.scrollIntoView({block: 'start'}); article.current?.focus({preventScroll: true}); }
  return <div className="help-page">
    <section className="help-intro">
      <div><span className="help-tag">随 App 内置 · 离线可读</span><h2>从第一件事，到持续托管</h2><p>按目录查操作，或搜索“截图”“用量未知”“DW”等关键词。</p></div>
      <div className="help-actions"><button className="button" onClick={onReplay}>重新查看上手引导</button><button className="button" onClick={() => download(`行知助手完整使用说明-v${version}.md`, guide)}><Download size={15}/>下载说明</button></div>
    </section>
    <label className="help-search"><Search size={18}/><input aria-label="搜索使用说明" placeholder="搜索功能、操作或问题" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" aria-label="清空说明搜索" onClick={() => setQuery('')}><X size={16}/></button>}<span role="status">{found.length} / {sections.length} 章</span></label>
    <div className="help-layout">
      <nav className="help-toc" aria-label="功能说明目录">{found.map(section => <button key={section.id} aria-current={current?.id === section.id ? 'page' : undefined} className={current?.id === section.id ? 'active' : ''} onClick={() => choose(section.id)}>{section.title}</button>)}</nav>
      {current ? <article ref={article} className="help-article" tabIndex={-1} aria-label={current.title}>
        <header><div><small>使用说明 · {String(currentIndex + 1).padStart(2, '0')}</small><h2>{current.title}</h2></div>{route && <button className="button small" onClick={() => onNavigate(route[0])}>{route[1]}<ArrowRight size={14}/></button>}</header>
        <Markdown text={current.body}/>
        <footer><span>行知助手 v{version}</span>{!query && currentIndex < sections.length - 1 && <button className="text-button" onClick={() => choose(sections[currentIndex + 1].id)}>下一章：{sections[currentIndex + 1].title}<ArrowRight size={14}/></button>}</footer>
      </article> : <section className="help-empty" role="status"><BookOpen size={28}/><h2>没有找到相关章节</h2><p>试试更短的关键词，例如“模型”“截图”或“备份”。</p><button className="button" onClick={() => setQuery('')}>查看全部说明</button></section>}
    </div>
  </div>;
}
