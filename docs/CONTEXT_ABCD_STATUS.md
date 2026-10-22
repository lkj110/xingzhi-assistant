# Context and evidence optimization acceptance status

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
