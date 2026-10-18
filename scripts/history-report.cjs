'use strict';
// Diagnostics for isolated history replay only; never used by budget admission.
const assert = require('node:assert/strict');
function sameUSD(report, actual, expected, field, stage) {
  const comparison = {field, stage, actual, expected, delta: actual - expected, tolerance: 1e-12};
  (report.ledgerComparisons ||= []).push(comparison);
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && actual >= 0 && expected >= 0
    && Math.abs(comparison.delta) < comparison.tolerance,
  'USD summary mismatch: ' + JSON.stringify(comparison));
}
function capture(report, a, jobId, taskId, phase) {
  report.phase = phase;
  const j = a?.data?.delegations?.find(row => row.id === jobId);
  const t = a?.data?.tasks?.find(row => row.id === taskId);
  report.currentRun = {phase, observedAt: new Date().toISOString(),
    job: j ? {status:j.status,lastError:j.lastError,lastErrorCode:j.lastErrorCode,summary:j.summary,nextRunAt:j.nextRunAt} : null,
    primary:t?.primaryArtifactId ?? null,
    runs:(a?.data?.agentRuns || []).filter(r => r.startedAt >= report.at).map(r => ({id:r.id,status:r.status,error:r.error})),
    executions:a?.executions?.size ?? null};
  report.job = report.currentRun.job;
  report.primary = report.currentRun.primary;
  report.policy = null;
  return report.currentRun;
}
function failed(report, error, a, jobId, taskId) {
  report.failedAt = report.phase;
  report.error = {message:error.message,code:error.code,stack:error.stack};
  report.passed = false;
  report.status = 'failed';
  try { capture(report, a, jobId, taskId, report.failedAt); }
  catch (observationError) { report.observationError = observationError.message; }
}
module.exports = {sameUSD,capture,failed};
