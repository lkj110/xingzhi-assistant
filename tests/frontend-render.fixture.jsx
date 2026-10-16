import React from 'react';
import {createRoot} from 'react-dom/client';
import Markdown from '../src/Markdown';
import {JsonPreview, LazyDetails, PagedList} from '../src/RenderBounds';
import AgentRunDetails from '../src/AgentRunDetails';
import ResultsPage from '../src/ResultsPage';
import {RunModels} from '../src/SpendControls';
import DeliveryBundle from '../src/DeliveryBundle';
import AgentPage from '../src/AgentPage';

const root = createRoot(document.getElementById('root'));
window.requests = []; window.pending = []; window.opened = [];
window.assistant = {call: async (action, input) => {
  window.requests.push({action, ...input});
  if (window.deferRequests) return new Promise(resolve => window.pending.push(value => resolve({data: value})));
  if (input.kind === 'agentStep') return {data: {args: {body: 'FULL-' + input.stepIndex + '-' + 'x'.repeat(90000) + '-TAIL'}, result: {ok: true}}};
  return {data: {id: input.id, start: input.start, total: 45, more: input.start + input.limit < 45, steps: Array.from({length: Math.min(input.limit, 45 - input.start)}, (_, i) => ({tool: 'read_source', reason: `step-${input.start + i}`, args: {preview: true}, result: {preview: true}}))}};
}};
const history = Array.from({length: 1005}, (_, i) => ({id: `history-${i}`, title: `历史文稿-${i}`, reason: '保留追溯', createdAt: '2026-10-16'}));
const groups = Array.from({length: 1003}, (_, i) => ({id: `group-${i}`, taskId: `task-${i}`, title: `事项-${i}`, projectId: 'p', projectName: '项目', status: 'progress', statusLabel: '处理中', current: [{id: `artifact-${i}`, title: `当前文稿-${i}`, chars: 1, outline: []}], primaryId: `artifact-${i}`, history, deliveries: []}));
const baseData = {projects: [{id: 'p', name: '项目', _viewRevision: 1}], delegations: [], tasks: [], sources: [], artifacts: [], agentActions: [], decisions: [], connectors: [], workRules: [], agentRuns: [], projectChanges: []};
const run = {id: 'r', _viewRevision: 1, stepCount: 45, steps: [], detailDeferred: true, modelCallsDetail: []};
const calls = Array.from({length: 1003}, (_, i) => ({id: `call-${i}`, model: 'fixture-model', routing: {reason: `reason-${i}`}, status: 'done'}));
const shortText = '| A | B |\n|---|---|\n| x | y |\n## after';
window.splitCount = 0;
const split = String.prototype.split;
String.prototype.split = function(...args) {if (this.valueOf() === shortText) window.splitCount++; return split.apply(this, args);};
const report = {revision: 'r', counts: {accepted: 0, drafts: 0, blocked: 0, selected: 0, bytes: 0}, items: [], sources: [], blockers: [], canExport: false};
const act = async (action, input) => {window.requests.push({action, ...input}); return report;};
const fullLegacyRun = {id: 'legacy', modelCallsDetail: calls, steps: Array.from({length: 1003}, (_, i) => Object.defineProperty({tool: 'fixture', reason: `legacy-${i}`}, 'args', {get() {window.argsReads++; return {body: 'x'.repeat(100000)};}}))};
window.renderCase = (name, options = {}) => {
  let node;
  if (name === 'lazy') node = <LazyDetails summary="展开详情">{() => {window.lazyCalls = (window.lazyCalls || 0) + 1; return <PagedList items={Array.from({length: options.total ?? 1005}, (_, i) => i)} label="测试记录分页">{i => <p className="row" key={i}>row-{i}</p>}</PagedList>;}}</LazyDetails>;
  if (name === 'json') node = <JsonPreview value={{body: 'x'.repeat(100000) + 'END', nested: {get untouched() {window.nestedReads = (window.nestedReads || 0) + 1; return 'read';}}, rows: Array.from({length: 10005}, (_, i) => i)}}/>;
  if (name === 'markdown') node = <div><span>{options.tick || 0}</span><Markdown text={options.long ? '# line\n'.repeat(100000) + 'END-MARKDOWN' : shortText}/></div>;
  if (name === 'results') node = <ResultsPage data={{...baseData, resultOverview: {groups, unlinked: history, counts: {current: groups.length, history: history.length}}}} openResult={value => window.opened.push(value)}/>;
  if (name === 'run') node = <LazyDetails summary="展开运行详情">{() => <AgentRunDetails run={{...run, _viewRevision: options.version ?? 1}} toolNames={{}}/>}</LazyDetails>;
  if (name === 'legacy') node = <LazyDetails summary="展开旧运行">{() => <AgentRunDetails run={fullLegacyRun} toolNames={{}}/>}</LazyDetails>;
  if (name === 'models') node = <RunModels run={{modelCallsDetail: calls}}/>;
  if (name === 'snapshot') {
    const source = Object.defineProperty({id: 'source', projectId: 'p', _viewRevision: options.version ?? 1, bodyRevision: options.version ?? 1}, 'content', {get() {throw new Error('body must not be read');}});
    node = <DeliveryBundle data={{...baseData, viewRevision: 'state', sources: [source]}} project={baseData.projects[0]} act={act}/>;
  }
  if (name === 'agent') {
    const job = {id: 'job', title: '测试委托', taskIds: [], watchers: [], callsUsed: 0, status: 'paused', executionPaused: true, intervalMinutes: 30, followups: []};
    node = <AgentPage data={{...baseData, delegations: [job], agentSettings: {}, agentRuns: Array.from({length: 25}, (_, i) => ({...run, id: `run-${i}`, jobId: job.id, trigger: `trigger-${i}`}))}} act={act}/>;
  }
  root.render(<React.Fragment key={name}>{node}</React.Fragment>);
};
window.fixtureReady = true;
