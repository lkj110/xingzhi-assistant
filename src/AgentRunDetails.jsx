import React, {useEffect, useState} from 'react';
import {call} from './api';
import {JsonPreview, LazyDetails, PagedList, Pagination} from './RenderBounds';
import {pageBounds} from './render-bounds.mjs';
import {RunModels, UsageLine} from './SpendControls';

function StepContent({step}) {
  return <><JsonPreview value={step.args} label="工具参数"/>{step.result != null && <LazyDetails summary="查看工具返回与来源">{() => <JsonPreview value={step.result} label="工具返回"/>}</LazyDetails>}{step.error && <p className="form-error">{step.error}</p>}</>;
}

function FullStep({run, index, version}) {
  const [value, setValue] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setValue(null); setError('');
    call('viewDetail', {kind: 'agentStep', id: run.id, stepIndex: index}).then(result => {if (active) setValue({step: result.step || result, version});}).catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [run.id, version, index, retry]);
  return error ? <p role="alert">{error} <button className="button small" onClick={() => setRetry(value => value + 1)}>重试读取步骤</button></p> : value?.version === version ? <StepContent step={value.step}/> : <p role="status">正在读取完整步骤…</p>;
}

export default function AgentRunDetails({run, toolNames, stateRevision}) {
  const [page, setPage] = useState(1), [loaded, setLoaded] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const version = JSON.stringify([run.id, run._viewRevision, run.finishedAt, run.stepCount ?? run.steps?.length, stateRevision]);
  const total = loaded?.version === version ? loaded.total : (run.stepCount ?? run.steps?.length ?? 0);
  const bounds = pageBounds(total, page, 20);
  useEffect(() => {
    if (!run.detailDeferred) return;
    let active = true; setError('');
    call('viewDetail', {kind: 'agentRun', id: run.id, start: bounds.start, limit: 20}).then(result => {if (active) setLoaded({...result, version});}).catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [run.id, run.detailDeferred, version, bounds.start, retry]);
  const renderStep = (step, index) => <div key={index} className="agent-run-step"><strong>{toolNames[step.tool] || step.tool}</strong><p>{step.reason}</p><StepContent step={step}/>{run.detailDeferred && <LazyDetails summary="查看完整步骤参数与结果">{() => <FullStep run={run} index={index} version={version}/>}</LazyDetails>}</div>;
  return <><RunModels run={run}/><UsageLine usage={run.usage} legacy/>
    {run.detailDeferred ? <>{error ? <p role="alert">{error} <button className="button small" onClick={() => setRetry(value => value + 1)}>重试读取运行记录</button></p> : loaded && loaded.version === version && loaded.start === bounds.start ? loaded.steps.map((step, index) => renderStep(step, bounds.start + index)) : <p role="status">正在读取运行步骤…</p>}<Pagination bounds={bounds} onChange={setPage} label="运行步骤分页"/></> : <PagedList items={run.steps || []} label="运行步骤分页">{renderStep}</PagedList>}
    {run.recovery && <p role="status">{run.recovery.message}</p>}{run.error && <p className="form-error">{run.error}</p>}
  </>;
}
