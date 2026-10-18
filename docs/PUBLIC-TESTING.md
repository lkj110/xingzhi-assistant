# Public tests and private release evidence

The public default command is `npm test`. It discovers `tests/*.test.cjs`, including synthetic recovery, isolation, redirected-output CLI, scale, permission-boundary, model preflight and release-refusal tests. New synthetic tests must remain discoverable; do not replace this glob with an older static list.

Run `npm ci`, `npm run build`, then `npm test` on a supported macOS development machine with Node.js 24+ and Xcode Command Line Tools. CI uses this sequence. Default tests do not require private workspaces, a sibling checkout, model credentials or live business services. Optional subscription evaluations are separate, use real services and may cost money.

## What is intentionally not distributed

Original installation receipts and captured personal/business workspaces are not public test fixtures. The private suites `context-repair-history`, `storage-method-history`, `storage-method-worker-history`, `system-legacy-pause` and `generic-recovery-historical` remain private. Captured-history portions of `system-history-replay` and `generic-recovery-performance`, and the original-installation byte check in `model-preflight-recovery`, also remain private.

Public helpers under `tests/helpers/` retain generic hashing, isolation/restore, output-FD refusal, preservation, mutation, performance-predicate and scale coverage without importing private runners. The platform-boundary corpus and snapshot-integrity examples are independently synthetic; they are not sanitized copies of production records and do not prove that real historical recovery succeeds. The frozen code oracle and runtime registry identities are not re-signed for public tests.

## Missing evidence is a failure

`node scripts/generic-recovery-performance.cjs` and `node scripts/prepared-upgrade-history.cjs` exit nonzero with `PRIVATE_HISTORY_UNAVAILABLE`. The historical-release test adapter in `scripts/system-release-history-tests.cjs` deliberately fails, rather than passing an empty suite or skipping absent evidence. The public default tests verify this refusal; they do not execute that adapter as a successful release group.

The release plan still has seven mandatory groups. Public synthetic/default success does not qualify a private release or authorize packaging. All `package` / `package:*` aliases use the controlled release entry and refuse missing release authorization. There is no public shortcut around those checks. Private historical evidence, package validation and final archive identity must be verified separately under the original release contract.

## Export status

This is the 0.42.4 source update, not a new GitHub Release or binary asset. The existing latest installer remains 0.40.0. Public source validation must be bound to the exact public candidate and kept separate from private package evidence. Earlier baseline sandbox tests do not certify the final candidate, an installation or a GitHub release; a clean, independent install/build/default run is required. Dependency versions and integrity records retain the public lock tree; no private dependency directory is required.
