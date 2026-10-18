'use strict';

// Optional bridge for existing assertion-based CLI tests. The immutable plan
// selects the script/argv and fresh evidence files, never an arbitrary shell.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const cases = JSON.parse(process.env.SYSTEM_RELEASE_CASES || '[]');
assert.ok(cases.length, 'missing frozen script cases');
for (const item of cases) {
  test(`[${item.id}] ${item.script}`, () => {
    for (const file of item.evidence || []) {
      assert.equal(fs.existsSync(file), false, `evidence must be fresh: ${file}`);
    }
    const result = spawnSync(process.execPath,
      [path.resolve(item.script), ...(item.args || [])], {
        cwd: process.cwd(), env: {...process.env, ...item.env}, shell: false,
        timeout: item.timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'script was interrupted');
    assert.equal(result.status, 0, 'assertion script failed');
    for (const file of item.evidence || []) {
      assert.ok(fs.statSync(file).isFile(), `missing evidence: ${file}`);
      // Legacy reports can additionally veto success. They never authorize it
      // without this fresh command completing and all node:test cases passing.
      if (file.endsWith('.json')) {
        const report = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.notEqual(report.passed, false);
        assert.notEqual(report.success, false);
        if (report.status !== undefined) assert.ok(['passed', 'expected-blocked'].includes(report.status));
        for (const key of ['skipped', 'unavailable', 'stale', 'failed']) assert.ok(!report[key], key);
        if (report.errors) assert.deepEqual(report.errors, []);
        assert.notEqual(report.layer, 'production', 'controlled/software test cannot claim production');
        if (report.productionDelivery !== undefined) assert.equal(report.productionDelivery, 'not_verified');
        assert.notEqual(report.productionDeliveryAccepted, true);
        if (report.releaseRunnerBinding) {
          assert.deepEqual(report.releaseRunnerBinding, {runId: process.env.SYSTEM_RELEASE_RUN_ID,
            sourceDigest: process.env.SYSTEM_RELEASE_SOURCE_DIGEST, packageDigest: process.env.SYSTEM_RELEASE_PACKAGE_DIGEST || null});
        }
        for (const scenario of report.scenarios || []) {
          assert.ok(['passed', 'expected-blocked'].includes(scenario.status), 'scenario did not pass');
          assert.ok(!scenario.skipped && !scenario.unavailable && !scenario.stale && !scenario.failed);
          if (scenario.assertions) {
            assert.ok(scenario.assertions.length > 0, 'empty scenario assertions');
            for (const assertion of scenario.assertions) assert.equal(assertion.passed, true, assertion.id);
          }
        }
      }
    }
  });
}
