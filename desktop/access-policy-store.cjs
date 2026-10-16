'use strict';
// Authority lives here, not in workspace grants. Call mutation APIs only from trusted
// App commands; never forward model/tool arguments as their options or scope.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = 3;
const clone = value => structuredClone(value);
const readCache = new Map();
function fileSignature(file) { const s = fs.lstatSync(file, { bigint: true }); if(s.isSymbolicLink()||!s.isFile()||(s.mode & 0o222n)===0n)throw failure('ACCESS_POLICY_STORAGE_FAILURE','权限库不是可写的常规文件');fs.accessSync(file,fs.constants.W_OK);return [s.dev,s.ino,s.mtimeNs,s.ctimeNs,s.size,s.mode].join(':'); }
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function locations(a) {
  return { store: path.join(a.dir, 'access-policy.json'), migration: path.join(a.dir, 'authorization-migration.json'), original: path.join(a.dir, 'protocol-migrations', 'before-authorization-v3.json'), lock: path.join(a.dir, 'access-policy.lock') };
}
function failure(code, message) { return Object.assign(Error(message), { code }); }
function syncDirectory(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let renamed = false;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file); renamed = true; syncDirectory(path.dirname(file));
  } catch (error) {
    error.code = 'ACCESS_POLICY_STORAGE_FAILURE'; error.committed = renamed;
    throw error;
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function sealed(payload) { return { payload, checksum: hash(payload) }; }
function readSealed(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000_000) throw failure('ACCESS_POLICY_CORRUPT', '权限记录格式无效');
  const item = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!item?.payload || item.checksum !== hash(item.payload)) throw failure('ACCESS_POLICY_CORRUPT', '权限记录校验失败');
  return item.payload;
}
function locked(a, fn) {
  const file = locations(a).lock;
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw failure('ACCESS_POLICY_STORAGE_FAILURE', '权限记录不可写');
    // Recover only a lock whose owning process demonstrably no longer exists.
    try {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw error;
      try { process.kill(pid, 0); } catch (gone) { if (gone.code === 'ESRCH') { fs.unlinkSync(file); return locked(a, fn); } }
    } catch { /* ambiguous ownership is fail closed */ }
    throw failure('ACCESS_POLICY_BUSY', '权限记录正在提交或锁状态需核对');
  }
  try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); return fn(); }
  finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
const string = (v, name) => { if (typeof v !== 'string' || !v || v.length > 4096 || /[\x00-\x1f]/.test(v)) throw failure('ACCESS_POLICY_INVALID_REQUEST', name + '无效'); return v; };
function principal(value) {
  if (!value || typeof value !== 'object') throw failure('ACCESS_POLICY_INVALID_REQUEST', '缺少明确主体');
  const kind = value.kind || (value.openId || value.accountId || value.subject ? 'account' : null);
  if (!['local', 'public', 'account', 'credential'].includes(kind)) throw failure('ACCESS_POLICY_INVALID_REQUEST', '主体类别无效');
  const result = { kind, provider: string(value.provider || (kind === 'local' ? 'app' : kind === 'public' ? 'web' : ''), '主体平台'), subject: string(value.subject || value.openId || value.accountId || (kind === 'local' ? 'workspace-user' : kind === 'public' ? 'anonymous' : ''), '主体身份') };
  if (value.tenantId !== undefined && value.tenantId !== null) result.tenantId = string(value.tenantId, '租户');
  return result;
}
function resource(value) {
  if (!value || typeof value !== 'object') throw failure('ACCESS_POLICY_INVALID_REQUEST', '缺少资源范围');
  const result = { kind: string(value.kind, '资源类别'), key: string(value.key || value.resourceKey, '资源身份') };
  for (const key of ['jobId', 'taskId', 'projectId', 'actionId', 'artifactId', 'contentHash', 'revision', 'updateMode']) if (value[key] !== undefined && value[key] !== null) result[key] = string(String(value[key]), key);
  if (!result.jobId && !result.taskId && !['folder', 'capability', 'model', 'snapshot', 'connector', 'collection'].includes(result.kind)) throw failure('ACCESS_POLICY_INVALID_REQUEST', '缺少事项或委托范围');
  if (['folder', 'output'].includes(result.kind) && (!path.isAbsolute(result.key) || path.normalize(result.key) !== result.key)) throw failure('ACCESS_POLICY_INVALID_REQUEST', '目录须为规范绝对路径');
  if (result.kind === 'document') result.key = require('./lark-connector.cjs').docTarget(result.key);
  return result;
}
function specOf(spec) {
  const principalScope = principal(spec.principalScope), resourceScope = resource(spec.resourceScope);
  if (!Array.isArray(spec.operations) || !spec.operations.length || spec.operations.some(op => typeof op !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(op))) throw failure('ACCESS_POLICY_INVALID_REQUEST', '操作范围无效');
  const metadata={};for(const key of ['approvedAt','userName'])if(typeof spec.metadata?.[key]==='string')metadata[key]=string(spec.metadata[key],key);
  return { principalScope, resourceScope, operations: [...new Set(spec.operations)].sort(),...(Object.keys(metadata).length?{metadata}:{}) };
}
function policyId(spec) { return 'policy-' + hash({ principalScope: spec.principalScope, resourceScope: spec.resourceScope }).slice(0, 32); }
function loadStore(a) {
  const store = readSealed(locations(a).store);
  if (store.version !== VERSION || !Array.isArray(store.events) || !Number.isSafeInteger(store.sequence) || store.sequence !== store.events.length) throw failure('ACCESS_POLICY_CORRUPT', '权限记录版本或序列无效');
  let previous = null;
  const revisions = new Map(), ids = new Set();
  for (const event of store.events) {
    const spec = specOf(event), id = policyId(spec), rev = (revisions.get(id) || 0) + 1;
    if (event.sequence !== ids.size + 1 || event.previousEventId !== previous || ids.has(event.eventId) || event.policyId !== id || event.grantRevision !== rev || !['allow', 'revoked', 'unknown'].includes(event.decision) || !event.commitId || !event.actor || !event.provenance) throw failure('ACCESS_POLICY_CORRUPT', '权限因果链损坏或分叉');
    const { eventId, ...body } = event;
    if (eventId !== 'policy-event-' + hash(body)) throw failure('ACCESS_POLICY_CORRUPT', '权限事件校验失败');
    ids.add(eventId); revisions.set(id, rev); previous = eventId;
  }
  if (store.head !== previous) throw failure('ACCESS_POLICY_CORRUPT', '权限记录头不匹配');
  return store;
}
function snapshot(a) {
  try {
    const files = locations(a), signature = fileSignature(files.store) + '/' + fileSignature(files.migration);
    const cached = readCache.get(files.store);
    if (cached?.signature === signature) return cached.value;
    const migration = readSealed(locations(a).migration), store = loadStore(a);
    if (migration.authorizationMigration !== 'complete' || store.migrationHash !== migration.workspaceHash) throw failure('ACCESS_POLICY_UNKNOWN', '权限迁移未完成');
    const effective = new Map();
    for (const event of store.events) for (const operation of event.operations) {
      const key = stable(event.principalScope) + ':' + operation + ':' + event.resourceScope.kind + ':' + event.resourceScope.key;
      if (!effective.has(key)) effective.set(key, new Map());
      effective.get(key).set(event.policyId, event);
    }
    const value = { ok: true, store, migration, effective };
    readCache.set(files.store, { signature, value });
    return value;
  } catch (error) { return { ok: false, code: 'ACCESS_POLICY_UNKNOWN', reason: error.code === 'ENOENT' ? 'missing' : ['ACCESS_POLICY_STORAGE_FAILURE','EACCES','EROFS'].includes(error.code) ? 'unwritable' : 'corrupt_or_incomplete', sequence: 0 }; }
}
function append(store, spec, decision, options) {
  const normalized = specOf(spec), id = policyId(normalized);
  const previous = store.events.findLast(e => e.policyId === id);
  const body = { ...normalized, policyId: id, decision, grantRevision: (previous?.grantRevision || 0) + 1, sequence: store.sequence + 1, previousEventId: store.head, actor: options.actor, provenance: options.provenance, commitId: options.commitId, at:new Date().toISOString() };
  const event = { ...body, eventId: 'policy-event-' + hash(body) };
  store.events.push(event); store.sequence = event.sequence; store.head = event.eventId;
  return event;
}
const LOCAL = Object.freeze({ kind: 'local', provider: 'app', subject: 'workspace-user' });
const PUBLIC = Object.freeze({ kind: 'public', provider: 'web', subject: 'anonymous' });
const LOCAL_TOOLS = ['plan_task', 'advance_task', 'revise_task', 'read_source', 'search_source', 'read_context', 'read_artifact', 'read_output_state', 'verify_task', 'verify_goal', 'complete', 'ask', 'request_access', 'wait', 'watch', 'list_sources', 'search_sources', 'verify_content', 'retire_output', 'cancel_task', 'resolve_wait', 'resolve_question', 'platform_inventory'];
function account(provider, row) {
  if (row?.principalScope) { try { return principal(row.principalScope); } catch { return null; } }
  const subject = row?.openId || row?.accountId || row?.username;
  return subject ? { kind: 'account', provider, subject, ...(row.tenantId ? { tenantId: row.tenantId } : {}) } : null;
}
function githubPrincipal(data) {
  // The sealed credential is an opaque App configuration identity. Never open
  // it here or persist it. No token means anonymous public GitHub, not a user.
  const sealed=data.agentSettings?.githubToken;
  return sealed?{kind:'credential',provider:'github',subject:'sealed-sha256:'+hash(sealed)}:{kind:'public',provider:'github',subject:'anonymous'};
}
function documentPrincipal(data, job, grant) {
  const explicit = account('lark', grant); if (explicit) return explicit;
  if (!grant?.target || !job) return null;
  const owner = account('lark', job.larkCreateGrant); if (!owner) return null;
  const sameURL = value => { try { return require('./lark-connector.cjs').docTarget(value) === require('./lark-connector.cjs').docTarget(grant.target); } catch { return false; } };
  const facts = (data.agentActions || []).filter(r => r.jobId === job.id && r.status === 'done' && (r.verified === true || r.result?.verified === true) && r.larkOpenId && sameURL(r.result?.url));
  const identities = new Set(facts.map(r => r.larkOpenId));
  return identities.size === 1 && identities.has(owner.subject) ? owner : null;
}
function communicationPrincipal(data,c){
  const explicit=account('lark',c.sendPolicy);if(explicit)return explicit;
  // Only verified sends under the exact same policy revision prove the sender.
  const subjects=new Set((data.agentActions||[]).filter(r=>r.connectorId===c.id&&r.target===c.target&&r.tool==='request_confirmation'&&r.status==='done'&&r.result?.verified===true&&(r.sendPolicyRevision===c.sendPolicy?.revision||r.authorization?.revision===c.sendPolicy?.revision)).map(r=>r.larkOpenId||r.senderId||r.result.senderId).filter(Boolean));
  return subjects.size===1?account('lark',{openId:[...subjects][0]}):null;
}
function ruleScope(rule){return {...clone(rule.config||{}),id:'rule:'+rule.id,sourceIds:[],taskIds:[],status:rule.status==='enabled'?'ready':'paused'};}
function collectLegacy(data, { collections = false } = {}) {
  const rows = [];
  function add(p, r, operations, source, allowed = true, metadata) {
    const principalScope = p || { kind: 'account', provider: r.kind, subject: 'unverified' };
    try { rows.push({ ...specOf({ principalScope, resourceScope: r, operations, metadata }), decision: allowed && p ? 'allow' : 'unknown', source }); }
    catch { /* invalid identities are reported without trusting them */ rows.push({ invalid: true, decision: 'unknown', source }); }
  }
  if (collections) rows.push(...require('./collection-permissions.cjs').legacy(data));
  const scopes=[...(data.delegations||[]),...(data.workRules||[]).filter(r=>r.config&&r.id).map(r=>ruleScope(r))];
  for (const j of scopes) {
    const scope = { jobId: j.id }, base = `delegations:${j.id}`;
    add(LOCAL, { kind: 'execution', key: 'app', ...scope }, LOCAL_TOOLS, base + ':scope');
    add(LOCAL, { kind: 'model', key: 'app', ...scope }, ['model', 'model_request'], base + ':scope');
    add(LOCAL, { kind: 'snapshot_collection', key: 'app', ...scope }, ['local_retention','local_read'], base + ':local_retention');
    if (j.allowWeb) add(PUBLIC, { kind: 'web', key: 'public', ...scope }, ['read_url', 'search_web'], base + ':allowWeb');
    for (const id of j.folderIds || []) { const f = (data.folders || []).find(f => f.id === id); add(LOCAL, { kind: 'folder', key: f?.path || id, ...scope }, ['list_folder', 'list_files', 'read_file'], base + ':folderIds:' + id, !!f && !f.removedAt); }
    for (const g of j.documentGrants || []) add(documentPrincipal(data, j, g), { kind: 'document', key: g.target, ...scope }, ['read_lark_document', 'read_url'], base + ':documentGrants',true,g);
    const lp = account('lark', j.larkCreateGrant);
    if (j.larkCreateGrant) add(lp, { kind: 'lark_destination', key: j.larkCreateGrant.target, ...scope }, ['prepare_lark_create', 'prepare_lark_update'], base + ':larkCreateGrant',true,j.larkCreateGrant);
    for (const p of j.larkCreatePolicies || []) if (p.mode === 'auto') add(account('lark', p), { kind: 'lark_destination', key: p.target, ...scope, taskId: p.taskId }, ['lark_create', ...(p.allowUpdate ? ['lark_update'] : [])], base + ':larkCreatePolicies',true,p);
    if (j.outputFolder && j.fileMode !== 'off') add(LOCAL, { kind: 'output', key: j.outputFolder, ...scope }, ['prepare_write_file', ...(j.fileMode === 'auto' ? ['write_file'] : [])], base + ':fileMode');
    if (j.githubRepo) {
      const gp = githubPrincipal(data);
      const operations = ['github_read', 'github_list'];
      for (const [field, op] of [['githubMode', 'github_create'], ['githubUpdateMode', 'github_update'], ['githubCommentMode', 'github_comment']]) if (gp.kind==='credential'&&['auto', 'ask'].includes(j[field])) operations.push('prepare_' + op, ...(j[field] === 'auto' ? [op] : []));
      add(gp, { kind: 'repository', key: j.githubRepo, ...scope }, operations, base + ':githubRepo');
    }
    if (j.dataPlatform && j.dataPlatform !== 'off') {
      const p=account('platform',typeof j.platformPrincipal==='string'?{username:j.platformPrincipal}:j.platformPrincipal);
      add(p,{kind:'platform',key:j.dataPlatform,...scope},['platform_query'],base+':dataPlatform');

    }
    for (const g of j.capabilityGrants || []) {
      const c = (data.capabilities || []).find(c => c.id === g.id);
      add(LOCAL, { kind: 'capability', key: g.id, revision: g.revision, updateMode: c?.updateMode || 'local', ...scope }, (c?.allowedTools || []).map(t => 'capability:' + t), base + ':capabilityGrants:' + g.id, !!c?.enabled && c.revision === g.revision && !c.removedAt);
    }
  }
  for(const c of data.connectors||[])if(c.kind==='chat'&&c.sendPolicy&&c.sendPolicy.mode!=='off'){
    const p=c.sendPolicy;
    add(communicationPrincipal(data,c),{kind:'connector',key:c.id,projectId:c.projectId,revision:p.revision},['prepare_request_confirmation','read_message',...(p.mode==='auto'?['request_confirmation']:[])],`connectors:${c.id}:sendPolicy`);
  }
  for (const t of data.tasks || []) if (!t.agentJobId && !t.deletedAt) {
    add(LOCAL, { kind: 'model', key: 'app', taskId: t.id }, ['model', 'model_request'], `tasks:${t.id}:scope`);
    add(LOCAL, { kind: 'execution', key: 'app', taskId: t.id }, LOCAL_TOOLS, `tasks:${t.id}:scope`);
    add(LOCAL, { kind:'snapshot_collection', key:'app', taskId:t.id }, ['local_retention','local_read'], `tasks:${t.id}:local_retention`);
  }
  // Existing App-owned snapshots are local retention, separate from remote ACLs.
  // A source merely sharing projectId=null never receives a job-wide grant.
  for (const [type, objects] of [['source', data.sources || []], ['artifact', data.artifacts || []]]) for (const row of objects) {
    if (row.deleted || row.deletedAt || row.withdrawnAt || row.projectExcluded || row.state === 'withdrawn' || row.retention === 'deleted') continue;
    const scopes = [];
    for (const t of data.tasks || []) if (type === 'artifact' ? row.taskId === t.id : (t.sourceIds || []).includes(row.id) || (t.contextBindings || []).some(b => b.sourceId === row.id && b.state === 'active')) scopes.push({ taskId: t.id, ...(t.agentJobId ? { jobId: t.agentJobId } : {}) });
    for (const j of data.delegations || []) if (type === 'source' ? (j.sourceIds || []).includes(row.id) : (data.tasks || []).some(t => t.id === row.taskId && t.agentJobId === j.id)) scopes.push({ jobId: j.id });
    if (!scopes.length) scopes.push({});
    for (const scope of scopes) add(LOCAL, { kind: 'snapshot', key: `${type}:${row.id}`, ...scope }, ['local_retention', 'local_read'], `${type}:${row.id}:local_retention`);
  }
  for (const r of data.agentActions || []) if (r.approvedAt && r.status === 'pending' && r.version && r.taskId && r.jobId && r.target) {
    const p = r.tool === 'write_file' ? LOCAL : r.tool?.startsWith('github_') ? githubPrincipal(data) : r.larkOpenId ? account('lark', { openId: r.larkOpenId }) : null;
    add(p, { kind: 'action', key: r.target, jobId: r.jobId, taskId: r.taskId, actionId: r.id, revision: r.version, ...(r.artifactId ? { artifactId: r.artifactId } : {}), contentHash: hash(r.content || '') }, [r.tool], `agentActions:${r.id}:approvedAt`);
  }
  return rows;
}
function capabilityPreviouslyBound(a,jobId,id){const current=snapshot(a);return !current.ok||current.store.events.some(e=>e.resourceScope.kind==='capability'&&e.resourceScope.key===id&&e.resourceScope.jobId===jobId);}
function inventory(a) {
  const current = snapshot(a);
  if (!current.ok) return { status: 'unknown', verified: 0, unknown: 0, rows: [], reason: current.reason };
  const rows = current.store.inventory || [];
  return { status: 'complete', workspaceHash: current.migration.workspaceHash, sequence: current.store.sequence, verified: rows.filter(r => r.decision === 'allow').length, unknown: rows.filter(r => r.decision !== 'allow').length, rows: clone(rows) };
}
function initialize(a, { recovered = !!a.recoveryFromBackup } = {}) {
  const files = locations(a);
  try {
    return locked(a, () => {
      let migration;
      if (fs.existsSync(files.migration)) migration = readSealed(files.migration);
      else {
        if (recovered || fs.existsSync(files.store) || fs.existsSync(files.original) || a.data?.runtime?.authorizationMigration?.status === 'complete' || a.data?.runtime?.authorizationMigration === 'complete' || a.data?.runtime?.authorizationMigrationComplete) return { status: 'unknown', reason: 'no_current_authority' };
        const bytes = fs.existsSync(a.file || '') ? fs.readFileSync(a.file) : Buffer.from(JSON.stringify(a.data));
        const data = JSON.parse(bytes.toString('utf8'));
        if (data.version !== 1 || !Array.isArray(data.tasks) || !Array.isArray(data.sources) || !data.settings) throw failure('ACCESS_POLICY_UNKNOWN', '迁移原状态不可验证');
        fs.mkdirSync(path.dirname(files.original), { recursive: true, mode: 0o700 }); syncDirectory(a.dir);
        atomic(files.original, bytes);
        migration = { version: VERSION, authorizationMigration: 'pending', workspaceHash: hash(bytes) };
        atomic(files.migration, sealed(migration));
      }
      if (migration.version !== VERSION || !['pending', 'complete'].includes(migration.authorizationMigration)) throw failure('ACCESS_POLICY_UNKNOWN', '权限迁移记录无效');
      if (migration.authorizationMigration === 'complete') { const current = snapshot(a); return current.ok ? inventory(a) : { status: 'unknown', reason: current.reason }; }
      // Resume solely from the fixed pre-migration bytes, never the chosen backup.
      let bytes;
      for (const file of [files.original, a.file]) if (file && fs.existsSync(file)) { const candidate = fs.readFileSync(file); if (hash(candidate) === migration.workspaceHash) { bytes = candidate; break; } }
      if (!bytes) return { status: 'unknown', reason: 'pinned_workspace_missing' };
      let store;
      if (fs.existsSync(files.store)) {
        store = loadStore(a);
        if (store.migrationHash !== migration.workspaceHash) throw failure('ACCESS_POLICY_UNKNOWN', '权限基线与原状态不匹配');
      } else {
        const rows = collectLegacy(JSON.parse(bytes.toString('utf8')), { collections: true });
        store = { version: VERSION, migrationHash: migration.workspaceHash, sequence: 0, head: null, events: [], inventory: rows.map(({ source, decision, invalid, ...spec }) => ({ source, decision, ...(invalid ? { invalid: true } : spec) })) };
        for (const row of rows.filter(r => !r.invalid)) append(store, row, row.decision, { actor: 'legacy_current_state', provenance: { kind: 'legacy_current_state', source: row.source, workspaceHash: migration.workspaceHash }, commitId: 'baseline-' + migration.workspaceHash });
        atomic(files.store, sealed(store));
      }
      loadStore(a);
      atomic(files.migration, sealed({ ...migration, authorizationMigration: 'complete', baselineHead: store.head }));
      return inventory(a);
    });
  } catch (error) { return { status: 'unknown', reason: error.code || 'corrupt', committed: !!error.committed }; }
}
function matches(granted, requested) {
  if (granted.kind !== requested.kind || granted.key !== requested.key) return false;
  // Unscoped local history is only readable through an unscoped trusted caller.
  if (!granted.jobId && !granted.taskId && (requested.jobId || requested.taskId)) return false;
  return ['jobId', 'taskId', 'projectId', 'actionId', 'artifactId', 'contentHash', 'revision', 'updateMode'].every(k => granted[k] === undefined || granted[k] === requested[k]);
}
function ownsSnapshot(a,r){
  const [type,...parts]=r.key.split(':'),id=parts.join(':'),row=a.data[type==='source'?'sources':'artifacts']?.find(v=>v.id===id);
  if(!row)return false;
  const bound=t=>type==='artifact'?row.taskId===t.id:(t.sourceIds||[]).includes(id)||(t.contextBindings||[]).some(b=>b.sourceId===id&&b.state==='active');
  if(r.taskId){const t=a.data.tasks?.find(t=>t.id===r.taskId&&!t.deletedAt&&!t.agentCancelled);return !!t&&(!r.jobId||t.agentJobId===r.jobId)&&bound(t);}
  if(r.jobId){const j=a.data.delegations?.find(j=>j.id===r.jobId&&!j.deletedAt);return !!j&&((type==='source'&&(j.sourceIds||[]).includes(id))||row.agentJobId===j.id||(a.data.tasks||[]).some(t=>t.agentJobId===j.id&&!t.deletedAt&&bound(t)));}
  return false;
}
function check(a, request) {
  let p, r;
  try { p = principal(request.principalScope); r = resource(request.resourceScope); string(request.operation, '操作'); }
  catch { return { allowed: false, decision: 'unknown', code: 'ACCESS_POLICY_INVALID_REQUEST', sequence: 0 }; }
  let missingSnapshot=false;
  if (r.kind === 'snapshot') {
    const [type, ...ids] = r.key.split(':'), row = a.data[type === 'source' ? 'sources' : 'artifacts']?.find(v => v.id === ids.join(':'));
    missingSnapshot=!row;
    if (row && (row.deleted || row.deletedAt || row.withdrawnAt || row.projectExcluded || row.state === 'withdrawn')) return { allowed:false, decision:'revoked', code:'ACCESS_POLICY_REVOKED', sequence:0 };
  }
  const current = snapshot(a);
  if (!current.ok) return { allowed: false, decision: 'unknown', code: current.code, sequence: 0, reason: current.reason };
  // Latest causal decision per policy AND operation; revoking one operation does
  // not erase a different operation's revocation or retention permission.
  const key = stable(p) + ':' + request.operation + ':' + r.kind + ':' + r.key;
  const all=[...(current.effective.get(key)?.values()||[])];
  const rows = all.filter(e => matches(e.resourceScope, r)||r.kind==='snapshot'&&e.decision==='revoked'&&!e.resourceScope.jobId&&!e.resourceScope.taskId);
  const allows = rows.filter(e => e.decision === 'allow');
  const denial = rows.find(e => e.decision !== 'allow' && !allows.some(g => g.sequence > e.sequence && matches(e.resourceScope, g.resourceScope)));
  const event = denial || allows.at(-1);
  if(r.kind==='snapshot'&&!event&&ownsSnapshot(a,r))return check(a,{principalScope:p,resourceScope:{kind:'snapshot_collection',key:'app',...(r.jobId?{jobId:r.jobId}:{}),...(r.taskId?{taskId:r.taskId}:{})},operation:request.operation});
  const decision = missingSnapshot&&event?.decision!=='revoked'?'unknown':event?.decision || 'unknown';
  return { allowed: decision === 'allow', decision, code: decision === 'allow' ? 'ACCESS_POLICY_ALLOWED' : decision === 'revoked' ? 'ACCESS_POLICY_REVOKED' : 'ACCESS_POLICY_UNKNOWN', sequence: current.store.sequence, grantRevision: event?.grantRevision || 0, policyId: event?.policyId || null };
}
function assert(a, request) { const result = check(a, request); if (!result.allowed) throw Object.assign(failure(result.code, '当前账号、资源及操作尚未获有效授权'), result); return result; }
function mutate(a, spec, decision, options = {}) {
  if (options.trusted !== true || !['user', 'user_command', 'authorization_policy'].includes(options.actor)) throw failure('ACCESS_POLICY_UNTRUSTED', '权限只能由可信用户命令或委托授权策略提交');
  const normalized = specOf(spec), commitId = options.commitId || crypto.randomUUID();
  const event = locked(a, () => {
    let current = snapshot(a);
    if(!current.ok&&current.reason==='unwritable')throw failure('ACCESS_POLICY_STORAGE_FAILURE','权限库不可写，不能提交新授权');
    if (!current.ok && decision === 'allow' && ['user','user_command'].includes(options.actor)) current = resetUnknown(a);
    if (!current.ok) throw failure('ACCESS_POLICY_UNKNOWN', '权限库需修复；不能从工作快照重新授权');
    const store = clone(current.store), id = policyId(normalized), prior = store.events.findLast(e => e.policyId === id);
    const duplicate = store.events.find(e => e.commitId === commitId && e.policyId === id);
    if (duplicate) {
      if (duplicate.decision !== decision || stable(duplicate.operations) !== stable(normalized.operations)) throw failure('ACCESS_POLICY_CONFLICT', '同一权限提交标识不能用于不同决定');
      return duplicate;
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== (prior?.grantRevision || 0)) throw failure('ACCESS_POLICY_CONFLICT', '权限修订已变化');
    const provenance = { kind: options.actor, ...(options.command ? { command: string(options.command, '命令') } : {}) };
    const next = append(store, normalized, decision, { actor: options.actor, provenance, commitId });
    try { atomic(locations(a).store, sealed(store)); } catch(error) { if(error.committed) { error.receipt={committed:true,sequence:next.sequence,grantRevision:next.grantRevision,commitId,eventId:next.eventId}; a.data.runtime ||= {}; a.data.runtime.accessPolicyProjectionPending=error.receipt; } throw error; }
    return next;
  });
  const receipt = { committed: true, sequence: event.sequence, grantRevision: event.grantRevision, policyId: event.policyId, commitId, eventId: event.eventId };
  a.data.runtime ||= {}; a.data.runtime.accessPolicyProjectionPending = receipt;
  try { reconcile(a); if (options.project) options.project(receipt); delete a.data.runtime.accessPolicyProjectionPending; }
  catch (error) { error.committed = true; error.receipt = receipt; throw error; }
  return receipt;
}
const grant = (a, spec, options) => mutate(a, spec, 'allow', options);
const revoke = (a, spec, options) => mutate(a, spec, 'revoked', options);
// An explicit new user grant can recover ONE scope after authority loss. The
// damaged bytes are preserved; no workspace/backup permissions are imported.
function resetUnknown(a) {
  const files = locations(a);
  for(const file of [files.store,files.migration]) if(fs.existsSync(file)) atomic(file+'.damaged-'+crypto.randomUUID(),fs.readFileSync(file));
  const migration={version:VERSION,authorizationMigration:'pending',workspaceHash:hash('explicit-reauthorization:'+crypto.randomUUID()),origin:'explicit_reauthorization'};
  atomic(files.migration,sealed(migration));
  atomic(files.store,sealed({version:VERSION,migrationHash:migration.workspaceHash,sequence:0,head:null,events:[],inventory:[]}));
  atomic(files.migration,sealed({...migration,authorizationMigration:'complete'}));
  return snapshot(a);
}
function trustedOptions(options) {
  if(typeof options === 'string') options={command:options,trusted:true,actor:'user_command'};
  if(!options?.trusted || !['user','user_command','authorization_policy'].includes(options.actor)) throw failure('ACCESS_POLICY_UNTRUSTED','需要可信命令及准确的操作者');
  string(options.command,'可信命令');
  return options;
}
function rowMap(rows) {
  const map=new Map();
  for(const row of rows.filter(r=>!r.invalid)) {
    const id=policyId(row), old=map.get(id);
    map.set(id,{...row,operations:[...new Set([...(old?.operations||[]),...row.operations])].sort()});
  }
  return map;
}
function policyChanges(before,after) {
  const old=rowMap(before),next=rowMap(after),changes=[];
  for(const [id,row] of old) {
    const desired=next.get(id);
    const removed=row.operations.filter(op=>!desired||desired.decision!=='allow'||!desired.operations.includes(op));
    if(row.decision==='allow'&&removed.length)changes.push({spec:{...row,operations:removed},decision:'revoked'});
  }
  for(const [id,row] of next) {
    const prior=old.get(id);
    const added=row.operations.filter(op=>!prior||prior.decision!=='allow'||!prior.operations.includes(op));
    if(row.decision==='allow'&&added.length)changes.push({spec:{...row,operations:added},decision:'allow'});
  }
  return changes;
}
function commitChanges(a,changes,options) {
  options=trustedOptions(options);
  if(!changes.length)return {committed:false,sequence:snapshot(a).store?.sequence||0,events:[]};
  const commitId=options.commitId||crypto.randomUUID();
  const receipt=locked(a,()=>{
    let current=snapshot(a);
    if(!current.ok)throw failure('ACCESS_POLICY_UNKNOWN','权限库缺失或损坏，请通过 grant 对具体范围重新授权');
    if(options.expectedSequence!==undefined&&options.expectedSequence!==current.store.sequence)throw failure('ACCESS_POLICY_CONFLICT','权限序列已变化');
    const store=clone(current.store),events=[];
    for(const change of changes){
      const spec=specOf(change.spec),id=policyId(spec);
      const old=store.events.find(e=>e.commitId===commitId&&e.policyId===id&&e.decision===change.decision&&stable(e.operations)===stable(spec.operations));
      events.push(old||append(store,spec,change.decision,{actor:options.actor,provenance:{kind:options.actor,command:options.command},commitId}));
    }
    const result={committed:true,commitId,sequence:store.sequence,events:events.map(e=>({eventId:e.eventId,policyId:e.policyId,grantRevision:e.grantRevision,sequence:e.sequence}))};
    try{atomic(locations(a).store,sealed(store));}catch(error){if(error.committed){error.receipt=result;a.data.runtime ||= {};a.data.runtime.accessPolicyProjectionPending=result;}throw error;}
    return result;
  });
  a.data.runtime ||= {};a.data.runtime.accessPolicyProjectionPending=receipt;
  try{reconcile(a);if(options.project)options.project(receipt);delete a.data.runtime.accessPolicyProjectionPending;}
  catch(error){error.committed=true;error.receipt=receipt;throw error;}
  return receipt;
}
function syncTrustedJob(a,job,options) {
  options=trustedOptions(options);
  const current=snapshot(a);if(!current.ok)throw failure('ACCESS_POLICY_UNKNOWN','当前权限库不可用');
  const data={...a.data,delegations:[clone(job)],workRules:[],sources:[],artifacts:[],tasks:[],agentActions:[]};
  // Keep action facts only for proving a legacy document grant's principal.
  data.agentActions=(a.data.agentActions||[]).filter(r=>r.jobId===job.id&&r.status==='done');
  const desired=collectLegacy(data).filter(r=>r.source.startsWith(`delegations:${job.id}:`));
  const previousJob=options.before?.delegations?.find(j=>j.id===job.id)||options.before;
  const existingScope=current.store.events.some(e=>e.resourceScope.jobId===job.id);
  const explicitSelection=['user','user_command'].includes(options.actor)&&job.dataPlatform&&job.dataPlatform!=='off'&&(previousJob?previousJob.dataPlatform!==job.dataPlatform:!existingScope);
  const identitySpec={principalScope:LOCAL,resourceScope:{kind:'platform_identity',key:job.dataPlatform||'off',jobId:job.id},operations:['platform_identity']};
  if(!desired.some(r=>r.resourceScope?.kind==='platform'&&r.decision==='allow')&&(explicitSelection||check(a,{...identitySpec,operation:'platform_identity'}).allowed))desired.push({...identitySpec,decision:'allow',source:`delegations:${job.id}:explicitPlatformIdentity`});
  let before;
  if(options.before) {
    const previous=options.before.delegations?.find(j=>j.id===job.id)||options.before;
    before=collectLegacy({...data,...(options.before.delegations?options.before:{}),delegations:[previous],workRules:[],sources:[],artifacts:[],tasks:[]}).filter(r=>r.source.startsWith(`delegations:${job.id}:`));
    // Synthetic bootstrap intents are durable policy, absent from legacy fields.
    for(const e of current.store.events)if(e.resourceScope.kind==='platform_identity'&&e.resourceScope.jobId===job.id&&check(a,{...e,operation:'platform_identity'}).allowed)before.push({...e,decision:'allow'});
  } else {
    // Full, explicit sync (new job or complete user scope confirmation).
    before=[];
    for(const map of current.effective.values())for(const e of map.values())if(e.resourceScope.jobId===job.id&&!['action','snapshot'].includes(e.resourceScope.kind))
      for(const operation of e.operations)if(check(a,{principalScope:e.principalScope,resourceScope:e.resourceScope,operation}).allowed)before.push({...e,operations:[operation],decision:'allow'});
  }
  return commitChanges(a,policyChanges(before,desired),options);
}
const platformTokens=new WeakMap();
function platformBound(a,job){
  const current=snapshot(a);if(!current.ok)return null;
  return current.store.events.findLast(e=>e.resourceScope.kind==='platform'&&e.resourceScope.jobId===job.id&&e.resourceScope.key===job.dataPlatform&&check(a,{...e,operation:'platform_query'}).allowed);
}
function platformIdentityRequest(a,job){
  const bound=platformBound(a,job);
  // Once bound, a revoked account grant cannot fall back to old bootstrap intent.
  if(bound)return {principalScope:clone(bound.principalScope),resourceScope:clone(bound.resourceScope),operation:'platform_query'};
  const current=snapshot(a),previous=current.ok&&current.store.events.findLast(e=>e.resourceScope.kind==='platform'&&e.resourceScope.jobId===job.id&&e.resourceScope.key===job.dataPlatform&&e.decision!=='unknown');
  const intent=current.ok&&current.store.events.findLast(e=>e.resourceScope.kind==='platform_identity'&&e.resourceScope.jobId===job.id&&e.resourceScope.key===job.dataPlatform);
  if(previous&&(!intent||intent.sequence<=previous.sequence))return {principalScope:clone(previous.principalScope),resourceScope:clone(previous.resourceScope),operation:'platform_query'};
  return {principalScope:LOCAL,resourceScope:{kind:'platform_identity',key:job.dataPlatform||'off',jobId:job.id},operation:'platform_identity'};
}
function checkPlatformIdentity(a,job){return check(a,platformIdentityRequest(a,job));}
function beginPlatformIdentity(a,job){
  const request=platformIdentityRequest(a,job),proof=assert(a,request),token=Object.freeze({});
  platformTokens.set(token,{dir:a.dir,jobId:job.id,platform:job.dataPlatform,request,sequence:proof.sequence,grantRevision:proof.grantRevision});return token;
}
function bindPlatformIdentity(a,job,identity,token){
  const proof=platformTokens.get(token);platformTokens.delete(token);
  const p=account('platform',identity);
  if(!p||!proof||proof.dir!==a.dir||proof.jobId!==job.id||proof.platform!==job.dataPlatform)throw failure('ACCESS_POLICY_UNKNOWN','平台身份未授权或授权范围已变化');
  const now=check(a,proof.request);
  if(!now.allowed||(proof.request.operation==='platform_identity'&&now.sequence!==proof.sequence)||now.grantRevision!==proof.grantRevision)throw failure('ACCESS_POLICY_CONFLICT','平台身份授权已变化，请重新核对');
  if(proof.request.operation==='platform_query'){
    const expected=proof.request.principalScope;
    if(expected.subject!==p.subject||((expected.tenantId||null)!==(p.tenantId||null)))throw failure('ACCESS_PRINCIPAL_CHANGED','平台账号或租户已变化，当前账号未授权，请重新选择授权范围');
    return {committed:false,principalScope:expected,sequence:now.sequence};
  }
  const spec={principalScope:p,resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']};
  const receipt=commitChanges(a,[{spec:{...proof.request,operations:['platform_identity']},decision:'revoked'},{spec,decision:'allow'}],{trusted:true,actor:'authorization_policy',command:'verified_platform_identity',expectedSequence:proof.sequence});
  job.platformPrincipal=p.tenantId?{username:p.subject,tenantId:p.tenantId}:p.subject;return {...receipt,principalScope:p};
}
function bindPlatformPrincipal(a,job,username,{trusted=false,expectedIdentityRevision}={}){
  if(!trusted||checkPlatformIdentity(a,job).grantRevision!==expectedIdentityRevision)throw failure('ACCESS_POLICY_UNKNOWN','平台身份许可已变化，不能绑定账号');
  return bindPlatformIdentity(a,job,{username},beginPlatformIdentity(a,job));
}
function grantLegacyDelta(a,before,options) {
  if(options===undefined){options=before;before=options.before;}
  options=trustedOptions(options);
  if(!before||!Array.isArray(before.tasks)||!Array.isArray(before.sources))throw failure('ACCESS_POLICY_INVALID_REQUEST','请提供可信命令之前的完整状态副本');
  return commitChanges(a,policyChanges(collectLegacy(before,{collections:true}),collectLegacy(a.data,{collections:true})),options);
}
function retainCreated(a,type,row,{job,task,command='retain_created',trusted=false,...options}={}) {
  if(!trusted)throw failure('ACCESS_POLICY_UNTRUSTED','正文保留只能由可信创建入口提交');
  type=type==='sources'?'source':type==='artifacts'?'artifact':type;
  if(!['source','artifact'].includes(type)||!row?.id||row.deleted||row.deletedAt||row.withdrawnAt||row.projectExcluded||row.state==='withdrawn')throw failure('ACCESS_POLICY_REVOKED','不能恢复已撤回正文');
  const saved=a.data[type==='source'?'sources':'artifacts']?.find(r=>r.id===row.id);
  if(saved&&(saved.deleted||saved.deletedAt||saved.withdrawnAt||saved.projectExcluded||saved.state==='withdrawn'))throw failure('ACCESS_POLICY_REVOKED','同一正文已撤回，迟到保存不能复活');
  if(typeof task==='string')task=a.data.tasks?.find(t=>t.id===task);
  if(typeof job==='string')job=a.data.delegations?.find(j=>j.id===job);
  if(!task&&type==='artifact')task=a.data.tasks?.find(t=>t.id===row.taskId);
  if(!job&&task?.agentJobId)job=a.data.delegations?.find(j=>j.id===task.agentJobId);
  if(task?.deletedAt||task?.agentCancelled||task&&job&&task.agentJobId!==job.id)throw failure('ACCESS_POLICY_REVOKED','材料所属事项已删除或不属于委托');
  const scope={...(job?{jobId:job.id}:{}),...(task?{taskId:task.id}:{})};
  const retainedRead=type==='source'&&job&&row.url&&row.principalScope&&checkTool(a,job,'read_lark_document',{url:row.url},{principalScope:row.principalScope}).allowed;
  if(job||task){if(!retainedRead)assert(a,{principalScope:LOCAL,resourceScope:{kind:'execution',key:'app',...scope},operation:'read_source'});}
  else if(options.collection){
    if(options.collection.principalScope?.kind!=='local'||options.collection.resourceScope?.kind!=='collection')throw failure('ACCESS_POLICY_INVALID_REQUEST','采集保留范围无效');
    for(const operation of ['local_retention','local_read'])assert(a,{...options.collection,operation});
  }
  else if(options.actor!=='user_command'&&options.actor!=='user')throw failure('ACCESS_POLICY_UNKNOWN','独立材料需要用户导入命令');
  const r={kind:'snapshot',key:`${type}:${row.id}`,...scope};
  const current=snapshot(a);if(!current.ok)throw failure('ACCESS_POLICY_UNKNOWN','当前保留许可未知');
  // Saving content is not authority to undo a historical deletion/withdrawal.
  if(current.store.events.some(e=>e.resourceScope.kind==='snapshot'&&e.resourceScope.key===r.key&&e.decision==='revoked'&&e.operations.some(op=>['local_retention','local_read'].includes(op))))throw failure('ACCESS_POLICY_REVOKED','正文保留曾被撤回，创建入口不能重新授权');
  if((job||task)&&['local_retention','local_read'].every(operation=>check(a,{principalScope:LOCAL,resourceScope:{kind:'snapshot_collection',key:'app',...scope},operation}).allowed)){
    row.accessPolicyQuarantined=false;return {committed:false,inherited:true,sequence:current.store.sequence,events:[]};
  }
  const specs=[r];if(job&&task)specs.push({kind:'snapshot',key:r.key,jobId:job.id});
  const changes=specs.filter(resourceScope=>!['local_retention','local_read'].every(operation=>check(a,{principalScope:LOCAL,resourceScope,operation}).allowed)).map(resourceScope=>({spec:{principalScope:LOCAL,resourceScope,operations:['local_retention','local_read']},decision:'allow'}));
  const receipt=commitChanges(a,changes,{...options,trusted:true,actor:options.actor||'authorization_policy',command});
  if(!changes.length)row.accessPolicyQuarantined=false;
  return receipt;
}
function requestsForTool(a, job, tool, args = {}, options = {}) {
  const scope = { ...(job?.id ? { jobId: job.id } : {}), ...(options.taskId ? { taskId: options.taskId } : {}) };
  const request = (p, r, operation = tool) => ({ principalScope: p, resourceScope: { ...r, ...scope }, operation });
  if (tool === 'model' || tool === 'model_request') return [request(LOCAL, { kind: 'model', key: 'app' })];
  if (['read_source', 'search_source', 'read_context', 'read_artifact', 'read_platform'].includes(tool)) {
    const key = args.sourceId ? 'source:' + args.sourceId : args.artifactId ? 'artifact:' + args.artifactId : null;
    if (!key) return [request(null, { kind: 'snapshot', key: 'unknown' })];
    return ['local_retention', 'local_read'].map(op => request(LOCAL, { kind: 'snapshot', key }, op));
  }
  if (['read_url', 'read_lark_document'].includes(tool)) {
    let target; try { target = require('./lark-connector.cjs').docTarget(args.url); } catch { /* a public web request */ }
    if (target) { const g = job?.documentGrants?.find(g => g.target === target); return [request(options.principalScope || documentPrincipal(a.data, job, g), { kind: 'document', key: target })]; }
    if (tool === 'read_lark_document') return [request(null, { kind: 'document', key: args.url })];
  }
  if (['read_url', 'search_web'].includes(tool)) return [request(PUBLIC, { kind: 'web', key: 'public' })];
  if (['list_folder', 'list_files', 'read_file'].includes(tool)) { const f = a.data.folders?.find(f => f.id === args.folderId); return [request(LOCAL, { kind: 'folder', key: f?.path })]; }
  if (tool === 'capability_call') {
    const c = a.data.capabilities?.find(c => c.id === args.capabilityId);
    return [request(LOCAL, { kind: 'capability', key: args.capabilityId, revision: c?.revision, updateMode: c?.updateMode || 'local' }, 'capability:' + args.tool)];
  }
  if(tool==='platform_query'&&Array.isArray(args.queries)&&args.queries.length===1&&args.queries[0]?.op==='identity')return [platformIdentityRequest(a,job)];
  if (tool === 'platform_query') return [request(options.principalScope || account('platform', typeof job?.platformPrincipal === 'string' ? { username: job.platformPrincipal } : job?.platformPrincipal), { kind: 'platform', key: job?.dataPlatform })];
  if(['prepare_request_confirmation','read_message'].includes(tool)||tool==='request_confirmation'&&!options.action){
    const c=(a.data.connectors||[]).find(c=>c.id===(args.connectorId||options.connectorId||options.action?.connectorId)&&c.projectId===job?.projectId),p=c?.sendPolicy;
    return [request(options.principalScope||account('lark',p),{kind:'connector',key:c?.id,projectId:c?.projectId,revision:p?.revision})];
  }
  if (options.action) {
    const r = options.action;
    const p=tool.startsWith('github_')?githubPrincipal(a.data):options.principalScope||r.principalScope||(tool==='write_file'?LOCAL:account('lark',{openId:r.larkOpenId,tenantId:r.tenantId}));
    return [request(p, { kind: 'action', key: r.target, actionId: r.id, revision: r.version, artifactId: r.artifactId, contentHash: hash(r.content || '') })];
  }
  const raw = tool.replace(/^prepare_/, '');
  if (raw === 'write_file') return [request(LOCAL, { kind: 'output', key: job?.outputFolder })];
  if (raw.startsWith('github_')) return [request(githubPrincipal(a.data), { kind: 'repository', key: job?.githubRepo })];
  if (['lark_create', 'lark_update'].includes(raw)) return [request(options.principalScope || account('lark', job?.larkCreateGrant), { kind: 'lark_destination', key: job?.larkCreateGrant?.target })];
  return [request(LOCAL, { kind: 'execution', key: 'app' })];
}
function checkTool(a, job, tool, args = {}, options = {}) {
  const results = requestsForTool(a, job, tool, args, options).map(r => check(a, r));
  // Automatic policies and exact user-approved actions are separate grants.
  // An explicit action revocation always wins over a broad automatic policy.
  if(options.action&&results.some(r=>!r.allowed)&&results.every(r=>r.decision!=='revoked')&&['write_file','github_create','github_update','github_comment','lark_create','lark_update','request_confirmation'].includes(tool)){
    const {action,...policyOptions}=options;
    const field={write_file:'fileMode',github_create:'githubMode',github_update:'githubUpdateMode',github_comment:'githubCommentMode'}[tool];
    const connector=tool==='request_confirmation'&&(a.data.connectors||[]).find(c=>c.id===action.connectorId&&c.projectId===job?.projectId);
    if(connector){policyOptions.connectorId=connector.id;}
    const auto=connector?connector.sendPolicy?.mode==='auto'&&connector.sendPolicy.template===action.content:field?job?.[field]==='auto':(job?.larkCreatePolicies||[]).some(p=>p.taskId===options.taskId&&p.mode==='auto'&&(tool!=='lark_update'||p.allowUpdate));
    if(auto){const result=checkTool(a,job,tool,args,policyOptions);if(result.allowed)return result;}
  }
  return results.find(r => !r.allowed) || results[0];
}
function assertTool(a, job, tool, args, options) { const result = checkTool(a, job, tool, args, options); if (!result.allowed) throw Object.assign(failure(result.code, '当前操作未授权、权限未知或已撤销，请核对授权范围'), result); return result; }
function reconcile(a) {
  const current = snapshot(a);
  a.data.runtime ||= {};
  if (current.ok) a.data.runtime.authorizationMigrationComplete = true;
  a.data.runtime.authorizationMigration = { status: current.ok ? 'complete' : 'unknown', ...(current.ok ? { workspaceHash: current.migration.workspaceHash, sequence: current.store.sequence } : {}) };
  a.data.runtime.accessPolicy = { status: current.ok ? 'ready' : 'unknown', sequence: current.store?.sequence || 0 };
  // Only policy-derived projections are used. Never read them back as authority.
  for (const j of a.data.delegations || []) {
    const hadDocumentGrants=Object.hasOwn(j,'documentGrants');
    const events = current.ok ? current.store.events.filter(e => e.resourceScope.jobId === j.id) : [];
    const permitted = (e, op) => check(a, { principalScope: e.principalScope, resourceScope: e.resourceScope, operation: op }).allowed;
    j.allowWeb = events.some(e => e.resourceScope.kind === 'web' && permitted(e, 'read_url'));
    j.folderIds = (a.data.folders || []).filter(f => events.some(e => e.resourceScope.kind === 'folder' && e.resourceScope.key === f.path && permitted(e, 'read_file'))).map(f => f.id);
    j.documentGrants = [...new Map(events.filter(e => e.resourceScope.kind === 'document' && permitted(e, 'read_lark_document')).map(e => [e.resourceScope.key, { ...e.metadata,approvedAt:e.metadata?.approvedAt||e.at,target: e.resourceScope.key, principalScope: e.principalScope, openId: e.principalScope.subject, policyId: e.policyId, grantRevision: e.grantRevision }])).values()];
    if(!hadDocumentGrants&&!j.documentGrants.length&&!events.some(e=>e.resourceScope.kind==='document'))delete j.documentGrants;
    j.capabilityGrants = [...new Map(events.filter(e => e.resourceScope.kind === 'capability' && e.operations.some(op => permitted(e, op))).map(e => [e.resourceScope.key, { id: e.resourceScope.key, revision: e.resourceScope.revision }])).values()];
    for (const [field, tool, kind] of [['fileMode', 'write_file', 'output'], ['githubMode', 'github_create', 'repository'], ['githubUpdateMode', 'github_update', 'repository'], ['githubCommentMode', 'github_comment', 'repository']]) {
      const all = events.filter(e => e.resourceScope.kind === kind);
      j[field] = all.some(e => permitted(e, tool)) ? 'auto' : all.some(e => permitted(e, 'prepare_' + tool)) ? 'ask' : 'off';
    }
    const destination = events.findLast(e => e.resourceScope.kind === 'lark_destination' && !e.resourceScope.taskId && permitted(e, 'prepare_lark_create'));
    if(destination)j.larkCreateGrant={...destination.metadata,approvedAt:destination.metadata?.approvedAt||destination.at,target:destination.resourceScope.key,openId:destination.principalScope.subject,principalScope:destination.principalScope};else delete j.larkCreateGrant;
    j.larkCreatePolicies = [...new Map(events.filter(e => e.resourceScope.taskId && e.resourceScope.kind === 'lark_destination' && permitted(e, 'lark_create')).map(e => [e.resourceScope.taskId,{ ...e.metadata,approvedAt:e.metadata?.approvedAt||e.at,taskId: e.resourceScope.taskId, mode: 'auto', target: e.resourceScope.key, openId: e.principalScope.subject, allowUpdate: permitted(e, 'lark_update') }])).values()];
    const platform = events.findLast(e => e.resourceScope.kind === 'platform' && permitted(e, 'platform_query'));
    const identity=events.findLast(e=>e.resourceScope.kind==='platform_identity'&&permitted(e,'platform_identity'));
    j.dataPlatform = platform?.resourceScope.key || identity?.resourceScope.key || 'off';
    if(platform)j.platformPrincipal=platform.principalScope.tenantId?{username:platform.principalScope.subject,tenantId:platform.principalScope.tenantId}:platform.principalScope.subject;
    else delete j.platformPrincipal;
    const output = events.findLast(e => e.resourceScope.kind === 'output' && ['write_file','prepare_write_file'].some(op => permitted(e, op)));
    j.outputFolder = output?.resourceScope.key || '';
    const repository = events.findLast(e => e.resourceScope.kind === 'repository' && permitted(e, 'github_read'));
    j.githubRepo = repository?.resourceScope.key || '';
  }
  for (const [kind, rows] of [['source', a.data.sources || []], ['artifact', a.data.artifacts || []]]) for (const row of rows) {
    const events = current.ok ? current.store.events.filter(e => e.resourceScope.kind === 'snapshot' && e.resourceScope.key === `${kind}:${row.id}`) : [];
    const collectionScopes=[];
    if(kind==='artifact'){const t=a.data.tasks?.find(t=>t.id===row.taskId);if(t)collectionScopes.push({taskId:t.id,...(t.agentJobId?{jobId:t.agentJobId}:{})});}
    else {for(const j of a.data.delegations||[])if(row.agentJobId===j.id||(j.sourceIds||[]).includes(row.id))collectionScopes.push({jobId:j.id});for(const t of a.data.tasks||[])if((t.sourceIds||[]).includes(row.id)||(t.contextBindings||[]).some(b=>b.sourceId===row.id&&b.state==='active'))collectionScopes.push({taskId:t.id,...(t.agentJobId?{jobId:t.agentJobId}:{})});}
    row.accessPolicyQuarantined = ![...events.map(e=>e.resourceScope),...collectionScopes.map(scope=>({kind:'snapshot',key:`${kind}:${row.id}`,...scope}))].some(resourceScope=>check(a,{principalScope:LOCAL,resourceScope,operation:'local_retention'}).allowed);
  }
  return a.data.runtime.accessPolicy;
}
module.exports = { capabilityPreviouslyBound, VERSION, LOCAL, PUBLIC, locations, initialize, inventory, check, assert, grant, revoke, checkTool, assertTool, requestsForTool, reconcile, collectLegacy, syncTrustedJob, grantLegacyDelta, retainCreated, checkPlatformIdentity, beginPlatformIdentity, bindPlatformIdentity, bindPlatformPrincipal, githubPrincipal, ruleScope, policyId, hash };
