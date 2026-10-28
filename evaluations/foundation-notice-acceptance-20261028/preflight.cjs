'use strict';
// Offline specimen checks only. This file reads this package's own data,
// performs no model dispatch, and does not import application implementation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {project} = require('./inputs.cjs');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const stimuli = read('stimuli.json');
const gold = read('gold.json');
const anchors = read('anchors.json');
const gate = read('gate.json');
let checks = 0;
const check = (condition, message) => { checks++; assert.ok(condition, message); };
const equalKeys = (object, keys, label) => {
  checks++;
  assert.deepEqual(Object.keys(object).sort(), [...keys].sort(), label);
};
const unique = (values, label) => check(new Set(values).size === values.length, label);

check(stimuli.schema === 1 && stimuli.synthetic === true, 'synthetic schema');
check(gold.schema === 1 && gold.modelInputForbidden === true, 'gold is offline only');
check(gold.canary.startsWith('FOUNDATION_CANDIDATE_GOLD_ONLY_'), 'compatible canary prefix');
check(stimuli.cases.length === 6 && gold.cases.length === 6, 'six business cases');
check(gate.sources.length === 1 && gate.sources[0].content.length < 200, 'one short gate source');
check(gate.includedInBusinessMetrics === false, 'gate excluded from business metrics');
check(gold.protocolGate.id === gate.id, 'gate gold identity');
check((gold.protocolGate.referenceDraft.match(/[。！？]/g) || []).length === 1, 'one gate summary sentence');
unique([gate.id, ...stimuli.cases.map(c => c.id)], 'distinct gate and case IDs');
check(stimuli.cases.filter(c => c.lane === 'generated').length === 2, 'two simple generation cases');
check(stimuli.cases.filter(c => c.lane === 'generated_revision').length === 1, 'one planned revision');
check(stimuli.cases.filter(c => c.lane === 'generated_restart').length === 1, 'one two-restart case');
check(stimuli.cases.filter(c => c.lane === 'fixed_invalid').length === 2, 'two immutable invalid drafts');
check(gold.cases.filter(c => c.expectedTerminal === 'review').length === 4, 'four review outcomes');
check(gold.cases.filter(c => c.expectedTerminal === 'blocked').length === 2, 'two blocked outcomes');
check(anchors.schema === 1 && anchors.modelInputForbidden === true, 'anchor schema');
check(anchors.offsetUnit === 'UTF-16 code units' && anchors.interval === '[start,end)', 'anchor units');
check(anchors.sourceHashAlgorithm === 'sha256-utf8-content', 'source hash convention');
check(anchors.cases.length === stimuli.cases.length, 'anchor case count');
if (fs.existsSync(path.join(__dirname, 'plan.json'))) {
  const plan = read('plan.json');
  checks++;
  assert.deepEqual(plan.protocolGate, gate, 'plan gate equals authored independent gate');
  checks++;
  assert.deepEqual(plan.order, [gate.id, ...stimuli.cases.map(c => c.id)], 'plan preserves gate-first order');
  checks++;
  assert.deepEqual(plan.caseLimits.map(c => c.id), stimuli.cases.map(c => c.id), 'plan budget IDs match new cases');
}

// These explicit title predicates encode this package's authored scope;
// their semantic rationale is reviewed in README rather than inferred by code.
const titleScope = {
  'P01-qingjia-notice': title => /清岬/.test(title) && /C组/.test(title) && /有效.*通行证|通行证.*有效/.test(title) && /夜班保管员/.test(title),
  'P02-haiting-conflict': title => /海汀HT-L319炉次/.test(title),
  'P03-taoyu-revision': title => /桃屿馆本轮已登记临时借阅证持有人/.test(title),
  'P04-fanyu-restart': title => /帆隅小剧场东区2026年3月9日/.test(title) && /历史/.test(title),
  'P05-sifangting-unapproved': title => /四方庭3月20日收件时/.test(title),
  'P06-xingjia-unjustified-choice': title => /杏岬XJ-C27批配餐/.test(title)
};

function checkProjection(spec) {
  const p = project(spec);
  const expectedKeys = ['title', 'description', 'criteria', 'sources'];
  if (spec.lane === 'fixed_invalid') expectedKeys.push('candidate');
  equalKeys(p, expectedKeys, spec.id + ' input keys');
  check(p.title === spec.title && p.criteria === spec.criteria, spec.id + ' input title/criteria exact');
  check(p.description.endsWith('\n' + spec.description), spec.id + ' historical framing and task preserved');
  check(p.sources.length === spec.sources.length, spec.id + ' source count');
  p.sources.forEach((source, i) => {
    equalKeys(source, ['title', 'content'], spec.id + ' source keys');
    check(source.title === spec.sources[i].title && source.content === spec.sources[i].content,
      spec.id + ' source bytes preserved');
  });
  if (spec.lane === 'fixed_invalid') check(p.candidate === spec.candidate, spec.id + ' candidate unchanged');
  const poison = {...spec, gold: gold.canary, rubric: gold.canary, budget: gold.canary,
    protocolGate: gold.canary, assertions: gold.canary, expectedTerminal: gold.canary,
    revision: {note: gold.canary}, workflow: [gold.canary],
    sources: spec.sources.map(s => ({...s, rubric: gold.canary, anchors: gold.canary}))};
  checks++;
  assert.deepEqual(project(poison), p, spec.id + ' metadata allowlist isolation');
  check(!JSON.stringify(p).includes(gold.canary), spec.id + ' no canary leakage');
}

function checkGoldAndAnchors(spec, expected, bound) {
  check(spec.id === expected.id && spec.id === bound.id, spec.id + ' identity alignment');
  unique(spec.sources.map(s => s.key), spec.id + ' unique source keys');
  spec.sources.forEach(s => check(s.key && s.title && s.content, spec.id + ' nonempty source'));
  check(expected.assertions.length > 0, spec.id + ' assertions present');
  unique(expected.assertions.map(a => a.id), spec.id + ' assertion IDs unique');
  check(bound.sources.length === spec.sources.length, spec.id + ' source hash count');
  check(bound.assertions.length === expected.assertions.length, spec.id + ' anchor assertion count');
  spec.sources.forEach(source => {
    const hash = bound.sources.find(s => s.sourceKey === source.key);
    check(Boolean(hash), spec.id + ' source hash exists');
    check(hash.sourceHash === sha256(source.content), spec.id + ' source hash exact');
    check(hash.utf16Length === source.content.length, spec.id + ' source UTF-16 length');
  });
  expected.assertions.forEach(assertion => {
    check(typeof assertion.meaning === 'string' && assertion.meaning.length > 0, assertion.id + ' readable meaning');
    check(assertion.evidence.length > 0, assertion.id + ' evidence present');
    const entry = bound.assertions.find(a => a.id === assertion.id);
    check(Boolean(entry) && entry.evidence.length === assertion.evidence.length, assertion.id + ' anchor count');
    assertion.evidence.forEach((ev, index) => {
      const source = spec.sources.find(s => s.key === ev.sourceKey);
      check(Boolean(source), assertion.id + ' source key resolves');
      check(ev.quote.length > 0 && source.content.includes(ev.quote), assertion.id + ' verbatim quote');
      check(source.content.indexOf(ev.quote) === source.content.lastIndexOf(ev.quote), assertion.id + ' unambiguous quote occurrence');
      const a = entry.evidence[index];
      check(a.sourceKey === ev.sourceKey && a.quote === ev.quote, assertion.id + ' anchor source and quote');
      check(Number.isInteger(a.start) && Number.isInteger(a.end) && a.start >= 0 && a.end > a.start, assertion.id + ' valid UTF-16 offsets');
      check(a.end <= source.content.length && source.content.slice(a.start, a.end) === ev.quote, assertion.id + ' exact UTF-16 slice');
      check(a.end - a.start === ev.quote.length && a.sourceHash === sha256(source.content), assertion.id + ' hash and quote length');
    });
  });
  if (expected.unknownText) check(expected.referenceDraft.includes(expected.unknownText), spec.id + ' exact unknown fragment');
  for (const [claimsKey, draftKey] of [['notificationClaims', 'referenceDraft'], ['initialNotificationClaims', 'initialReferenceDraft']]) {
    for (const claim of expected[claimsKey] || []) {
      equalKeys(claim, ['text', 'kind'], spec.id + ' notice claim keys');
      check(claim.kind === 'proposal', spec.id + ' notices remain proposals');
      check(claim.text.length > 0 && expected[draftKey].includes(claim.text), spec.id + ' exact notice fragment');
    }
  }
}

checkProjection(gate);
checkGoldAndAnchors(gate, gold.protocolGate, anchors.protocolGate);
for (const spec of stimuli.cases) {
  const expected = gold.cases.find(c => c.id === spec.id);
  const bound = anchors.cases.find(c => c.id === spec.id);
  check(Boolean(expected) && Boolean(bound), spec.id + ' gold and anchors exist');
  check(titleScope[spec.id](spec.title), spec.id + ' task title scope');
  for (const draft of [expected.referenceDraft, expected.initialReferenceDraft, spec.candidate].filter(Boolean)) {
    check(titleScope[spec.id](draft.split('\n')[0]), spec.id + ' every draft title scope');
  }
  checkProjection(spec);
  checkGoldAndAnchors(spec, expected, bound);
  if (spec.lane === 'fixed_invalid') {
    check(expected.expectedTerminal === 'blocked', spec.id + ' invalid terminal');
    check(expected.invalidClaims.length > 0, spec.id + ' invalid claims present');
    expected.invalidClaims.forEach(c => check(spec.candidate.includes(c), spec.id + ' invalid candidate fragment exact'));
    check(!expected.referenceDraft, spec.id + ' no replacement of fixed candidate');
  } else {
    check(expected.expectedTerminal === 'review' && expected.referenceDraft.length > 0, spec.id + ' generated reference');
    const limit = Number((spec.criteria.match(/不超过(\d+)个汉字/) || [])[1]);
    if (limit) check(Array.from(expected.referenceDraft).filter(c => !/\s/u.test(c)).length <= limit, spec.id + ' conservative all-character length bound');
  }
  if (spec.id.startsWith('P01-') || spec.lane === 'generated_revision') {
    check(expected.notificationClaims.length > 0, spec.id + ' proposal fragments required');
  }
  if (spec.id.startsWith('P02-')) check(expected.unknownText.length > 0, 'conflict unresolved fragment required');
  if (spec.lane === 'generated_revision') {
    check(spec.revision.command === 'revise' && spec.revision.note.length > 0, 'one predetermined revision');
    check(spec.workflow.filter(x => x === 'revise_once').length === 1, 'exactly one revision step');
    check(expected.initialReferenceDraft.length > 0 && expected.initialNotificationClaims.length > 0, 'initial reference and proposals');
    expected.initialRequiredAssertions.forEach(id => check(expected.assertions.some(a => a.id === id), 'initial assertion ID resolves'));
    const lines = expected.referenceDraft.split('\n');
    check(lines.length === 4 && lines.slice(1).every(line => /^- \S/.test(line)), 'one title plus exactly three bullets');
    check(!Object.prototype.hasOwnProperty.call(project(spec), 'revision'), 'revision withheld from initial model input');
  }
  if (spec.lane === 'generated_restart') {
    check(spec.workflow.includes('cold_restart_before_advance') && spec.workflow.includes('cold_restart_at_review'), 'two specified restart positions');
    check(spec.workflow.includes('assert_no_model_dispatch_on_restart') && spec.workflow.includes('assert_same_draft_and_verification'), 'restart preservation checks');
  }
}

// JS string offsets are UTF-16 code units, including a surrogate-pair case.
const surrogateProbe = '甲😀乙';
check(surrogateProbe.length === 4 && surrogateProbe.slice(1, 3) === '😀', 'UTF-16 offset implementation');
const files = ['stimuli.json', 'gate.json', 'gold.json', 'anchors.json', 'inputs.cjs', 'preflight.cjs', 'README.md'];
const hashes = Object.fromEntries(files.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, name))).digest('hex')]));
process.stdout.write(JSON.stringify({ok: true, checks, gate: gate.id, businessCases: stimuli.cases.length,
  callsDispatched: 0, scope: 'offline structure, verbatim source anchors, and projection allowlist only', files: hashes}, null, 2) + '\n');
