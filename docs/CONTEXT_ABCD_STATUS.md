# Context and evidence optimization acceptance status

## Latest real-model result: R7 readiness stopped early, 2026-10-26

The approved six-pair retest compared the R6 candidate against R7. Only 5/12
branches were attempted: all four fixed-draft branches and the R6 long-document
branch. Six actual calls were recorded; five have known usage totaling 95,616
input-plus-output tokens. The sixth hit the two-minute idle timeout without a
usage receipt, so the ledger stopped all further dispatch. Total usage remains
unknown; no retry, budget top-up or automatic continuation was performed.

Both arms completed valid checks for 2/6 planned cases. R6 correctly passed the
qualified fixed draft; R7 falsely blocked it over an inference-label requirement.
Both correctly blocked the invalid fixed draft. Fixed false-block counts were
0/1 versus 1/1; fixed wrong releases were 0/1 in both arms. No generated dynamic
artifact was accepted, so hallucination and dynamic gate rates are not estimable.

The two completed fixed pairs cost 37,203 versus 58,413 tokens (+57.01%). R7 used
one additional format-repair call costing 19,832 tokens. This is neither an
equal-quality full-task comparison nor an estimate of overall cost: one verdict
differed and one other call has unknown usage. No dynamic pair completed.

**Readiness did not pass.** The 90-second file-observation exercise, revisions and
whole-goal checks were not reached. A–D remains unaccepted; no main evaluation or
installed-app replacement occurred. See the [R7 report and next repair
priorities](CONTEXT_ABCD_R7_LIVE.md).

## Latest offline stage: R7 four repairs, 2026-10-26

Historical observations now retain their explicit past observation scope while
current-state receipts still expire. Revision instructions distinguish metadata
titles from body headings. Active requirement projection retires attributable
old requirements, deduplicates supplements, and preserves unchanged legacy gaps.
Independent whole-goal checks receive bounded original evidence and continuation
information before their first call.

All four P2 findings from the independent reviewer were fixed and reverified.
The final expanded run passed 687/687 checks across 42 files; the independent
reviewer passed 339/339 across 19 files, with no skips or unresolved P0–P2.
These overlapping counts are not additive. Windows production build passed.
Real-model calls and tokens were both zero. A–D remains unaccepted; the installed
app was not replaced and the formal main evaluation was not started.
See [R7 repairs, independent audit, and the approved six-pair 96-call / 2M-token
retest](CONTEXT_ABCD_R7.md). The live retest above stopped under its unknown-usage
rule; its remaining call count does not authorize continuation.

## Earlier real-model result: R6 readiness, 2026-10-26

Six fresh paired cases completed execution and independent result audit, using
59 calls and 1,172,572 input-plus-output tokens within the approved 96-call /
2,000,000-token limit. Candidate procedure completion was 3/6 versus 2/6;
dynamic full acceptance was 1/4 versus 0/4. Candidate total tokens were 742,928
versus 429,644 (+72.92%). There were no jointly completed dynamic cases, so
equal-success dynamic token efficiency is not estimable.

Candidate false blocks were 0/1 fixed and 0/3 dynamic, versus 1/1 and 2/2.
Wrong releases were 0/1 fixed in both arms and 0/2 dynamic for the candidate
(baseline 0/0, not estimable). Final accepted generated-artifact hallucinations
were 0/1 for the candidate; the baseline had no final accepted generated artifact.
These small denominators do not establish zero risk or statistical noninferiority.

**Readiness did not pass.** Historical observation receipts expired during slow
turns; two revision drafts retained an old body heading and were correctly blocked.
These four follow-up priorities were implemented and passed offline review in
R7 above; its interrupted live run did not establish their effectiveness. No formal main evaluation or installed-app upgrade
was started. See the [audited R6 report](CONTEXT_ABCD_R6_LIVE.md).

## Prior offline stage: R6 lifecycle and evidence handoff, 2026-10-26

The evaluation lifecycle and evidence handoff repairs passed independent review
after three categories of findings were fixed. The reviewer ran 186/186 checks;
the final expanded regression passed 380/380. That offline stage made no new
real-model calls or installed-app upgrade. See [R6 repairs and the subsequent
approved evaluation plan](CONTEXT_ABCD_R6.md). A–D remains unaccepted.

## Earlier real-model result: R5b readiness, 2026-10-23

The four reviewed repairs in `bb2ab900703b4200ea5d1bc9542c5c9c22c1f8cb`
were tested on six fresh paired cases. All 12 branches were attempted, using
50 calls and 955,117 tokens within the approved 96-call / 1,500,000-token limit.
Candidate tokens were 488,485 versus 466,632 for the baseline (+4.68%).
The candidate correctly passed the valid fixed draft and blocked the invalid
one; the baseline blocked both. End-to-end tasks did not finish. Candidate
revision drafts passed task verification, but the runner skipped delegation
completion verification before acceptance, so no revision phase ran. These
revision failures cannot be attributed to model quality or product revision
capability. Raw completion rates are retained with this limitation.

**Readiness did not pass.** No formal main evaluation or installed-app upgrade
was started. See the [full R5b report](CONTEXT_ABCD_R5B.md) for denominators,
independent audit, known regression failures, and the next repair order.
The results below describe earlier snapshots, not the latest candidate.

## Earlier development snapshot

This development snapshot includes strict grounding, input attribution, A–D
context improvements, and the reviewed repairs found by the first held-out run.
It is **not an accepted release**. Existing installations are not upgraded by
this source upload.

## Frozen candidate result

The baseline and candidate both enabled strict verification. The primary model
ran 48 paired cases: 24 fixed drafts, 12 end-to-end tasks, and 12 revision tasks.

| Measure | Baseline | Original candidate |
| --- | ---: | ---: |
| Total input and output tokens | 2,768,059 | 1,737,747 |
| Correct delivered tasks | 24/48 | 17/48 |
| Delivered-task hallucinations | 0/34 | 0/26 |
| Fixed valid-draft false blocks, excluding technical failures | 0/12 | 0/12 |
| Fixed valid-draft technical failures | 0/12 | 1/12 |
| Fixed invalid-draft wrong releases | 0/12 | 0/12 |
| Fixed invalid-draft technical failures | 3/12 | 6/12 |
| Complete required evidence groups | 52/56 | 49/56 |

The token reduction does not compensate for reduced successful delivery. The
preselected repeat completed 23/24 branches before its stage reservation limit;
the second-model run completed 32/32 branches but did not pass acceptance.
All real calls, including failed calls and earlier probes, totaled 396 calls and
6,705,365 tokens. Zero observed events in these small samples do not establish
zero risk. Anonymous model reviewers audited answers, supporting evidence, and
actual deliverable titles; this was not a human blind study.

## Reviewed repair snapshot

- Recover bounded tool parameter mistakes without producing false receipts or
  progress; authorization, version, and lifecycle failures remain blocking.
- Accept strictly bound structured verification defects, still as failures.
- Locate unique exact consistency quotations locally; ambiguous quotations
  still need an exact position.
- Recognize finite pure uncertainty expressions without extending their scope
  over an appended unsupported assertion.
- Update revision titles with the body; retain version checks, permissions,
  and final independent whole-document verification.

Independent repair review found no remaining P0–P2 within the reviewed scope.
95 targeted regression tests and four additional application-flow integration
tests passed. Integration tests replace only model transport and use synthetic
usage; they do not establish real-model quality. The repair requires another
frozen, fresh-sample evaluation before release. The whole repository suite has
known failures and has not been certified fully green on Windows or macOS.

## Development setup

Use Node.js 24 and `npm ci`. The local multilingual encoder uses the revision and
SHA-256 entries in `resources/evidence-encoder/manifest.json`. Large model weights
and tokenizer data are intentionally not stored in Git; obtain them explicitly
with `node scripts/install-evidence-encoder.cjs`. Runtime inference disables
remote model access and reports lexical fallback when local resources are absent.
No workspace data, credentials, user-profile backups, or raw authenticated model
traces are included in this repository snapshot.

Windows is the tested host. Common business logic is reusable in principle;
macOS resource loading, packaging, and native integrations need their own checks.
Shared-module extraction is scheduled after repaired A–D acceptance, so its
structural changes do not contaminate the current evaluation.
