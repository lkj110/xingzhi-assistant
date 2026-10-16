import React, {memo, useEffect, useMemo, useState} from 'react';
import {pageBounds, textPage} from './render-bounds.mjs';

// The render function is deliberately called only while open: hidden children
// must not serialize data, mount effects, or build their DOM in advance.
export function LazyDetails({summary, children, defaultOpen = false, ...props}) {
  const [open, setOpen] = useState(defaultOpen);
  return <details {...props} open={open} onToggle={event => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}><summary>{summary}</summary>{open ? children() : null}</details>;
}

export function Pagination({bounds, onChange, label = '记录分页'}) {
  if (bounds.pageCount <= 1) return null;
  return <nav className="versions-pager" aria-label={label}>
    <button type="button" className="button small" disabled={bounds.page === 1} onClick={() => onChange(bounds.page - 1)}>上一页</button>
    <span>第 {bounds.page} / {bounds.pageCount} 页 · 共 {bounds.total} 条</span>
    <label>跳转页码 <input aria-label={`${label}跳转页码`} type="number" min={1} max={bounds.pageCount} value={bounds.page} style={{width: '5em'}} onChange={event => {if (event.target.value) onChange(Math.max(1, Math.min(bounds.pageCount, Math.trunc(Number(event.target.value)) || 1)));}}/></label>
    <button type="button" className="button small" disabled={bounds.page === bounds.pageCount} onClick={() => onChange(bounds.page + 1)}>下一页</button>
  </nav>;
}

export function PagedList({items, children, pageSize = 20, label = '记录分页', resetKey}) {
  const [selection, setSelection] = useState({key: resetKey, page: 1});
  const bounds = pageBounds(items.length, selection.key === resetKey ? selection.page : 1, pageSize);
  return <>{items.slice(bounds.start, bounds.end).map((item, index) => children(item, bounds.start + index))}<Pagination bounds={bounds} label={label} onChange={page => setSelection({key: resetKey, page})}/></>;
}

export const PagedText = memo(function PagedText({text = '', label = '原文', pageSize = 8000}) {
  const [page, setPage] = useState(1);
  useEffect(() => {setPage(1);}, [text]);
  const value = textPage(text, page, pageSize);
  return <div className="bounded-text">
    {value.pageCount > 1 && <p className="help-text">{label}：字符 {value.start + 1}–{value.end} / {text.length}（UTF-16）；跨页表情会重叠展示。</p>}
    <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>{value.text}</pre>
    <Pagination label={`${label}分页`} bounds={value} onChange={setPage}/>
  </div>;
});

// A navigable JSON tree keeps every property accessible without stringify of
// whole objects, full strings, or unopened descendants.
export function JsonPreview({value, label = 'JSON'}) {
  const array = Array.isArray(value), object = value !== null && typeof value === 'object';
  const keys = useMemo(() => object && !array ? Object.keys(value) : null, [value, object, array]);
  const [page, setPage] = useState(1);
  if (!object) return <PagedText text={typeof value === 'string' ? value : String(value)} label={label} pageSize={2000}/>;
  const bounds = pageBounds(array ? value.length : keys.length, page, 20);
  const visible = array ? Array.from({length: bounds.end - bounds.start}, (_, i) => bounds.start + i) : keys.slice(bounds.start, bounds.end);
  return <div className="json-preview" aria-label={label}>
    <small>{array ? '数组' : '对象'} · {bounds.total} 项</small>
    {visible.map(key => {
      const child = value[key], nested = child !== null && typeof child === 'object';
      return <LazyDetails key={key} summary={<code>{String(key).slice(0, 160)}：{nested ? (Array.isArray(child) ? `数组（${child.length} 项）` : '对象') : typeof child === 'string' ? `${JSON.stringify(child.slice(0, 100))}${child.length > 100 ? `…（${child.length} 字符）` : ''}` : String(child)}</code>}>
        {() => <>{String(key).length > 160 && <PagedText text={String(key)} label="完整字段名"/>}<JsonPreview value={child} label={`${label} 字段内容`}/></>}
      </LazyDetails>;
    })}
    <Pagination label={`${label}字段分页`} bounds={bounds} onChange={setPage}/>
  </div>;
}
