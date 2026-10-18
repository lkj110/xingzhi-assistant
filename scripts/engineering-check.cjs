#!/usr/bin/env node
'use strict';
// Mechanical admission checks supplement, never replace, independent review.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const PACKAGE_ENTRIES = ['package', ...['agent','audit','continuity','rules','fixes','projects','connected','collaboration','productivity','managed','intake','reliable','autonomy','engagement','expansion','closure','resilience','rhythm','intelligence','unified','flow','share'].map(n => 'package:' + n)];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function need(value, code, message) { if (!value) { const error = Error(`${code}: ${message}`); error.code = code; throw error; } }
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function uniqueStrings(values, name) {
  need(Array.isArray(values) && values.length > 0 && values.every(v => typeof v === 'string' && v.trim() === v && v.length > 0)
    && new Set(values).size === values.length, 'INVALID_DEFINITION', `${name} must contain unique nonempty strings`);
}
function canonicalFile(file) {
  const resolved=path.resolve(file);need(resolved===fs.realpathSync(resolved),'LINKED_REVIEW_INPUT','review inputs must use canonical paths without symlink ancestors: '+file);return resolved;
}
function definition(file) {
  file = canonicalFile(file); const d = json(file);
  const fields = ['version','id','baselineCommit','risk','author','design','designReview','allowedFiles','requirements','verificationPlan','metricsDir'];
  need(d && typeof d === 'object' && same(Object.keys(d).sort(), fields.sort()), 'INVALID_DEFINITION', 'unknown/missing iteration fields');
  need(d.version === 1 && typeof d.id === 'string' && /^[A-Z0-9][A-Z0-9-]*$/.test(d.id), 'INVALID_DEFINITION', 'iteration identity');
  need(/^[a-f0-9]{40}$/.test(d.baselineCommit) && ['A','B','C'].includes(d.risk) && typeof d.author === 'string' && d.author.trim(), 'INVALID_DEFINITION', 'baseline/risk/author');
  uniqueStrings(d.allowedFiles,'allowedFiles'); uniqueStrings(d.requirements,'requirements');
  for (const rel of d.allowedFiles) need(!path.isAbsolute(rel) && !rel.includes('\\') && !rel.split('/').some(v => !v || ['.','..'].includes(v)) && !/[\0*?\[\]]/.test(rel), 'INVALID_DEFINITION', `exact file required: ${rel}`);
  for (const key of ['design','designReview','verificationPlan','metricsDir']) need(typeof d[key] === 'string' && path.isAbsolute(d[key]) && !d[key].includes('\0'), 'INVALID_DEFINITION', `${key} must be an absolute path`);
  return d;
}
function validateReview({definitionFile, design, reviewFile, planFile}) {
  const d = definition(definitionFile);
  for(const file of [d.design,d.designReview,d.verificationPlan])canonicalFile(file);
  const r = json(canonicalFile(reviewFile || d.designReview));
  const required = ['format','status','author','reviewer','baselineCommit','designSha256','iterationDefinition','iterationDefinitionSha256','verificationPlanSha256','requirementIds','reviewDocument','openFindings'];
  need(r && same(Object.keys(r).sort(),required.sort()),'INVALID_REVIEW','unknown/missing design review fields');
  need(r.format === 'engineering-design-review/v1' && r.status === 'approved' && r.author === d.author
    && typeof r.reviewer === 'string' && r.reviewer.trim() && r.reviewer !== r.author, 'INDEPENDENT_REVIEW_REQUIRED','approved non-author design review required');
  need(Array.isArray(r.openFindings) && r.openFindings.length === 0,'OPEN_DESIGN_FINDINGS','design has unresolved findings');
  canonicalFile(r.iterationDefinition);
  need(fs.realpathSync(r.iterationDefinition) === fs.realpathSync(definitionFile) && r.iterationDefinitionSha256 === hash(definitionFile)
    && r.baselineCommit === d.baselineCommit,'STALE_DEFINITION','review does not bind this iteration and baseline');
  need(fs.realpathSync(design || d.design) === fs.realpathSync(d.design) && r.designSha256 === hash(d.design), 'STALE_DESIGN', 'design changed after approval');
  need(fs.realpathSync(reviewFile || d.designReview) === fs.realpathSync(d.designReview),'STALE_REVIEW','definition points at another review');
  need(fs.realpathSync(planFile || d.verificationPlan) === fs.realpathSync(d.verificationPlan) && r.verificationPlanSha256 === hash(d.verificationPlan),'STALE_PLAN','verification plan changed after approval');
  const plan = json(d.verificationPlan);
  need(same(r.requirementIds,d.requirements) && same(plan.requirements,d.requirements),'REQUIREMENT_MISMATCH','definition, review and plan requirements differ');
  need(r.reviewDocument && same(Object.keys(r.reviewDocument).sort(),['path','sha256']) && typeof r.reviewDocument.path === 'string'
    && path.isAbsolute(r.reviewDocument.path) && hash(r.reviewDocument.path) === r.reviewDocument.sha256,'STALE_REVIEW_DOCUMENT','independent review document missing/changed');
  canonicalFile(r.reviewDocument.path);
  return {definition:d, review:r};
}
function minimumRisk(files) {
  if (files.some(f => /^(desktop\/|src\/api\.js$|tests\/|scripts\/|package(?:-lock)?\.json$|\.gitignore$|AGENTS\.md$|docs\/(development\/(engineering-standards|audit-and-iteration)|design\/change-validation-policy)\.md$)/.test(f))) return 'C';
  return files.some(f => /^(src\/|public\/|vite\.config)/.test(f)) ? 'B' : 'A';
}
function git(source, args) { return cp.execFileSync('git',['-C',source,...args],{encoding:'utf8',maxBuffer:16*1024*1024}).trimEnd(); }
const nul = value => value.split('\0').filter(Boolean);
function changes(source, baselineCommit) {
  need(fs.realpathSync(git(source,['rev-parse','--show-toplevel'])) === fs.realpathSync(source),'WRONG_GIT_ROOT','source must be its own Git repository/worktree');
  need(git(source,['rev-parse',baselineCommit+'^{commit}']) === baselineCommit,'MISSING_BASELINE','baseline commit is unavailable');
  cp.execFileSync('git',['-C',source,'merge-base','--is-ancestor',baselineCommit,'HEAD'],{stdio:'pipe'});
  const tracked = new Set(nul(git(source,['ls-files','-z']))), untracked = nul(git(source,['ls-files','--others','--exclude-standard','-z']));
  const addedCode = [];
  function walk(rel) {
    if (rel === 'desktop/native/bin') return;
    const file = path.join(source,rel); if (!fs.existsSync(file)) return;
    for (const entry of fs.readdirSync(file,{withFileTypes:true})) {
      const sub = rel+'/'+entry.name;
      if (entry.name === '.DS_Store') continue;
      if (entry.isDirectory()) walk(sub);
      else if (!tracked.has(sub)) addedCode.push(sub);
    }
  }
  for (const root of ['desktop','src','scripts','tests']) walk(root);
  return {files:[...new Set([...nul(git(source,['diff','--no-renames','--name-only','-z',baselineCommit,'--'])),...untracked,...addedCode])].sort(),
    dirty:[...new Set([...nul(git(source,['diff','--no-renames','--name-only','-z','HEAD','--'])),...untracked,...addedCode])].sort(), tracked:[...tracked]};
}
function check({source, definitionFile, requireClean=false}) {
  source = fs.realpathSync(source); const rules = []; let d, delta;
  const rule = (id, fn) => { try { const evidence=fn(); rules.push({id,status:'passed',evidence}); } catch(error) { rules.push({id,status:'failed',code:error.code || 'CHECK_FAILED',message:error.message}); } };
  rule('E10-DEFINITION',()=>{d=definition(definitionFile);return {id:d.id,baseline:d.baselineCommit};});
  if (d) {
    rule('E09-DESIGN-REVIEW',()=>{const {review}=validateReview({definitionFile});return {reviewer:review.reviewer,designSha256:review.designSha256,planSha256:review.verificationPlanSha256};});
    rule('E10-WRITE-SCOPE',()=>{delta=changes(source,d.baselineCommit);const outside=delta.files.filter(f=>!d.allowedFiles.includes(f));need(outside.length===0,'OUTSIDE_WRITE_SCOPE',outside.join(', '));return delta.files;});
    if (delta) {
      rule('E01-MINIMUM-RISK',()=>{const minimum=minimumRisk(delta.files);need('ABC'.indexOf(d.risk)>='ABC'.indexOf(minimum),'RISK_DOWNGRADE',`declared ${d.risk}, minimum ${minimum}`);return {declared:d.risk,minimum};});
      rule('E10-PRIVATE-INPUTS',()=>{const prohibited=delta.tracked.filter(f=>/(^|\/)(workspace\.json|auth\.json|credentials\.json|vault\.key|\.env(?:\.[^/]*)?|\.codex|backups|capture-payloads)(\/|$)/.test(f));need(!prohibited.length,'PRIVATE_INPUT_TRACKED',prohibited.join(', '));return 'forbidden tracked filenames absent; not a secret-content scan';});
      if(requireClean) rule('E10-COMMITTED-CANDIDATE',()=>{need(!delta.dirty.length,'DIRTY_CANDIDATE',delta.dirty.join(', '));return {commit:git(source,['rev-parse','HEAD'])};});
    }
  }
  rule('E10-VERSION',()=>{const p=json(path.join(source,'package.json')),l=json(path.join(source,'package-lock.json'));need(p.version===l.version && p.version===l.packages?.['']?.version,'VERSION_MISMATCH','package and lock versions differ');return p.version;});
  rule('E10-PACKAGE-ENTRYPOINTS',()=>{const scripts=json(path.join(source,'package.json')).scripts;
    need(same(Object.keys(scripts).filter(k=>k==='package'||k.startsWith('package:')).sort(),[...PACKAGE_ENTRIES].sort()),'PACKAGE_BYPASS','unknown/missing package alias');
    for(const name of PACKAGE_ENTRIES)need(scripts[name]==='node scripts/release.cjs build','PACKAGE_BYPASS',name);
    need(scripts.release==='node scripts/release.cjs' && scripts['test:share']==='node scripts/release.cjs verify','PACKAGE_BYPASS','release/verify commands');
    for(const [file,command] of [['package-share.cjs','build'],['share-verify.cjs','verify'],['cost-efficiency-package.cjs','build'],['cost-efficiency-package-verify.cjs','verify']]) {
      const text=fs.readFileSync(path.join(source,'scripts',file),'utf8');
      need(text===compatibilitySource(command),'PACKAGE_BYPASS',file);
    }
    return {aliases:PACKAGE_ENTRIES.length,compatibilityScripts:4};
  });
  return {schema:1,passed:rules.every(r=>r.status==='passed'),iterationId:d?.id,rules,
    manual:['Design correctness and reviewer identity are organizational judgments.','Full package content/native/experience and seven-group verification are separate release gates.','Real user permissions, notarization and production delivery are not proved by this check.']};
}
function compatibilitySource(command) {
  return `#!/usr/bin/env node\n'use strict';\n// Compatibility entrypoint: all admission and verification lives in release.cjs.\nrequire('./release.cjs').cli(['${command}', ...process.argv.slice(2)]);\n`;
}
module.exports={PACKAGE_ENTRIES,hash,definition,validateReview,minimumRisk,changes,check,compatibilitySource};
if(require.main===module) {
  try { const args=process.argv.slice(2),i=args.indexOf('--definition');need(i>=0&&args[i+1],'MISSING_DEFINITION','use --definition ABSOLUTE_JSON [--clean]');const result=check({source:path.resolve(__dirname,'..'),definitionFile:args[i+1],requireClean:args.includes('--clean')});console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1; }
  catch(error){console.error(JSON.stringify({passed:false,code:error.code,error:error.message}));process.exitCode=1;}
}
