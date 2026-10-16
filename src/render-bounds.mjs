export const TEXT_PAGE_SIZE = 8000;
export const MARKDOWN_CHAR_LIMIT = 24000;
export const MARKDOWN_LINE_LIMIT = 400;

export function pageBounds(total, page = 1, size = 20) {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.max(1, Math.min(pageCount, Math.trunc(page) || 1));
  const start = (current - 1) * size;
  return {page: current, pageCount, start, end: Math.min(total, start + size), total};
}

// Fixed offsets avoid scanning preceding pages. Overlap a surrogate pair at the
// boundary so neither page renders a broken Unicode character.
export function textPage(text, page = 1, size = TEXT_PAGE_SIZE) {
  const bounds = pageBounds(text.length, page, size);
  let {start, end} = bounds;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start--;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end++;
  return {...bounds, start, end, text: text.slice(start, end)};
}

export function needsTextPaging(text) {
  if (text.length > MARKDOWN_CHAR_LIMIT) return true;
  let offset = -1;
  for (let lines = 0; lines < MARKDOWN_LINE_LIMIT; lines++) {
    offset = text.indexOf('\n', offset + 1);
    if (offset === -1) return false;
  }
  return true;
}

// Only persisted version metadata belongs in effect dependencies. In legacy
// state runtime.revision covers same-length body edits; never inspect a body.
export function metadataVersion(data, {projectId} = {}) {
  const jobs = (data.delegations || []).filter(row => !projectId || row.projectId === projectId || row.id === data.projects?.find(p => p.id === projectId)?.jobId);
  const jobIds = new Set(jobs.map(row => row.id));
  const tasks = (data.tasks || []).filter(row => !projectId || row.projectId === projectId || jobIds.has(row.agentJobId));
  const taskIds = new Set(tasks.map(row => row.id));
  const stamp = row => [row.id, row._viewRevision, row.bodyRevision, row.revision, row.version, row.hash, row.updatedAt, row.createdAt, row.status, row.projectId, row.previousSourceId, row.projectExcluded, row.deleted, row.archivedAt];
  const entities = [
    (data.projects || []).filter(row => !projectId || row.id === projectId), jobs, tasks,
    (data.sources || []).filter(row => !projectId || row.projectId === projectId),
    (data.artifacts || []).filter(row => !projectId || taskIds.has(row.taskId)),
    (data.agentActions || []).filter(row => !projectId || taskIds.has(row.taskId) || jobIds.has(row.jobId)),
    (data.decisions || []).filter(row => !projectId || jobIds.has(row.jobId)),
    (data.workRules || []).filter(row => !projectId || row.config?.projectId === projectId),
    (data.connectors || []).filter(row => !projectId || row.projectId === projectId),
  ];
  return JSON.stringify([data.viewRevision, data.runtime?.commitId, data.runtime?.revision, data.runtime?.suspended, data.stewardshipStatus?.reason, ...entities.map(rows => rows.map(stamp))]);
}
