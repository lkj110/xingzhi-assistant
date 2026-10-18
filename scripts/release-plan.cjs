'use strict';
const path=require('node:path');
const template={
  "schema": 1,
  "fullSuite": {
    "tests": "all",
    "before": [
      {
        "script": "scripts/build-image-ocr.cjs"
      },
      {
        "script": "scripts/build-pdf-ocr.cjs"
      }
    ],
    "testConcurrency": 4,
    "env": {
      "GENERIC_RECOVERY_FIXTURE_ROOT": "{historyRoot}/private-history/generic-recovery",
      "SYSTEM_HISTORY_SNAPSHOT_ROOT": "{historyRoot}",
      "GENERIC_RECOVERY_PERFORMANCE_REPORT": "{output}/generic-performance.json"
    }
  },
  "policyPause": {
    "tests": [
      "tests/system-execution-policy.test.cjs",
      "tests/system-pending-check.test.cjs",
      "tests/system-pause-delivery.test.cjs",
      "tests/input-upgrade-recovery.test.cjs",
      "tests/root-delivery-pipeline.test.cjs",
      "tests/root-reading-revision.test.cjs",
      "tests/root-continuation-actions.test.cjs",
      "tests/final-context-budget.test.cjs",
      "tests/final-context-review-invariants.test.cjs",
      "tests/root-repair-validation.test.cjs",
      "tests/context-repair-ui.test.cjs",
      "tests/context-access-classification.test.cjs",
      "tests/check-reading-finalization.test.cjs",
      "tests/check-finalization-transport.test.cjs",
      "tests/final-context-review-segments.test.cjs",
      "tests/evidence-storage-method.test.cjs",
      "tests/storage-method-resume.test.cjs",
      "tests/projection-performance.test.cjs",
      "tests/generic-consumption-flow.test.cjs",
      "tests/generic-consumption-gates-ui.test.cjs",
      "tests/generic-consumption-gates.test.cjs",
      "tests/generic-platform-backup.test.cjs",
      "tests/generic-platform-chunks.test.cjs",
      "tests/generic-platform-integration.test.cjs",
      "tests/generic-projection-archive.test.cjs",
      "tests/generic-projection-coverage.test.cjs",
      "tests/generic-projection-recovery.test.cjs",
      "tests/generic-projection-scope.test.cjs",
      "tests/generic-recovery-items.test.cjs",
      "tests/generic-recovery-preflight.test.cjs",
      "tests/generic-recovery-storage-family.test.cjs",
      "tests/generic-consumption-admission.test.cjs",
      "tests/generic-consumption-response.test.cjs",
      "tests/acquisition-recovery-admission.test.cjs",
      "tests/acquisition-local-recovery.test.cjs",
      "tests/generic-recovery-backup-selection.test.cjs",
      "tests/consumption-projection-performance.test.cjs",
      "tests/model-preflight-recovery.test.cjs",
      "tests/subscription-health.test.cjs",
      "tests/subscription-health-metadata.test.cjs",
      "tests/subscription-preflight.test.cjs",
      "tests/consumption-scale.test.cjs",
      "tests/model-preflight-health-upgrade.test.cjs",
      "tests/identity-scheduling.test.cjs",
      "tests/identity-scheduling-package-contract.test.cjs",
      "tests/identity-scheduling-agent.test.cjs",
      "tests/identity-strategy-cold.test.cjs"
    ],
    "scenarioTests": {
      "D01": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: job pending refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: task pending refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: workspace pending refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: nested journal pending refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: permission projection refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: storage failure refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: global pause refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: job pause refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: sleep refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: terminal refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: source cursor refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: manual mode retains global pause/window semantics; task pause always wins"
        }
      ],
      "D02": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "D02: real permission/model/budget/window guards compose before preparation and keep usage unchanged"
        }
      ],
      "D03": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-05: all four action classes preserve original identity; only reconcile may bypass budget"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02/P1-05: live same-job/shared-project executions beat preparation and unresolved effects; only authenticated self is excluded"
        },
        {
          "file": "tests/root-continuation-actions.test.cjs",
          "name": "controller ask → exact approval → same pending action executes through tick"
        },
        {
          "file": "tests/root-continuation-actions.test.cjs",
          "name": "uncertain mismatch gets one automatic readback attempt and no blind write"
        }
      ],
      "D04": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02/P1-05: live same-job/shared-project executions beat preparation and unresolved effects; only authenticated self is excluded"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-04: exhausted A cannot veto independent B or donate/reset its counters"
        }
      ],
      "D05": [
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "persisted old failure → cold upgraded load → automatic preflight → original primary check → one same-target update/readback → review"
        },
        {
          "file": "tests/system-pending-check.test.cjs",
          "name": "P03: legacy pause proof is precise, idempotent and journal-backed; no generic new-hash revival"
        },
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "upgrade does not bypass same_policy"
        },
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "upgrade does not bypass missing_diagnostic"
        }
      ],
      "D06": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-04: two legal episodes select in stable task order and preserve the other owner"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-04: exhausted A cannot veto independent B or donate/reset its counters"
        },
        {
          "file": "tests/system-pending-check.test.cjs",
          "name": "P03: execution pause precedes legacy no-progress and preserves owner/counters"
        }
      ],
      "D07": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "D07: ordinary recovery passes pure policy, durable preparation, real tick and the chosen task worker"
        }
      ],
      "D08": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-04: exhausted A cannot veto independent B or donate/reset its counters"
        },
        {
          "file": "tests/root-delivery-pipeline.test.cjs",
          "name": "real Agent loop: old Lark receipt → failed check → 19 sources → atomic rebind/reopen → six consumed reads → revise → verify → same Lark readback → review"
        }
      ],
      "D09": [
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "persisted old failure → cold upgraded load → automatic preflight → original primary check → one same-target update/readback → review"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "D09/D10: no phantom running or planner spin for waiting, accepted or unowned blocked work"
        }
      ],
      "D10": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "D09/D10: no phantom running or planner spin for waiting, accepted or unowned blocked work"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "D10: watcher and retry times use the same policy; deadline cannot bypass retry"
        }
      ],
      "S01": [
        {
          "file": "tests/system-pause-delivery.test.cjs",
          "name": "C13 controlled: pause during revised content check, cold restore, same-target delivery without old-counter handoff"
        },
        {
          "file": "tests/system-pending-check.test.cjs",
          "name": "P03: source/intent/replaced output/cycle exhaustion invalidate pending ownership"
        },
        {
          "file": "tests/final-context-review-invariants.test.cjs",
          "name": "review: ordinary current user requirements and check findings survive projection unchanged"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-05: all four action classes preserve original identity; only reconcile may bypass budget"
        }
      ],
      "S02": [
        {
          "file": "tests/root-delivery-pipeline.test.cjs",
          "name": "real Agent loop: old Lark receipt → failed check → 19 sources → atomic rebind/reopen → six consumed reads → revise → verify → same Lark readback → review"
        },
        {
          "file": "tests/root-delivery-pipeline.test.cjs",
          "name": "uncertain update keeps the original action and reconciles with reads, never a second write"
        },
        {
          "file": "tests/root-delivery-pipeline.test.cjs",
          "name": "mismatched remote body never reaches review and never silently republishes"
        }
      ],
      "S03": [
        {
          "file": "tests/final-context-budget.test.cjs",
          "name": "real subscription envelope includes profile and fails before charges or transport"
        },
        {
          "file": "tests/final-context-review-invariants.test.cjs",
          "name": "review: complete wire preflight rejects before spending, charging or invoking a model"
        },
        {
          "file": "tests/final-context-review-invariants.test.cjs",
          "name": "review: a changed accepted boundary during a model await rejects the late result"
        },
        {
          "file": "tests/final-context-review-invariants.test.cjs",
          "name": "review: obligation page is invalidated when a later callback withdraws its evidence"
        }
      ],
      "S04": [
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "content and post-delivery result conclusions have independent bounded slots across a cold restart"
        },
        {
          "file": "tests/root-reading-revision.test.cjs",
          "name": "mixed useful and duplicate reads deliver the useful sibling even with historical duplicate debt"
        },
        {
          "file": "tests/root-reading-revision.test.cjs",
          "name": "pure duplicate verification switches once to a persisted concluding call without accepting missing evidence"
        }
      ],
      "S05": [
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "persisted old failure → cold upgraded load → automatic preflight → original primary check → one same-target update/readback → review"
        },
        {
          "file": "tests/system-pause-delivery.test.cjs",
          "name": "C13 controlled: pause during revised content check, cold restore, same-target delivery without old-counter handoff"
        },
        {
          "file": "tests/root-reading-revision.test.cjs",
          "name": "the cumulative $200 fixture budget still stops a model call before new reading"
        },
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "upgrade does not bypass unknown_usage"
        }
      ],
      "S06": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-01: frozen inspect/UI/peek never call command probes, initialize ledger, consume forcedNext or write requirements"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: job pending refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: task pending refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: workspace pending refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: nested journal pending refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: permission projection refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: storage failure refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: global pause refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: job pause refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: sleep refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: terminal refuses UI/tick/prepare with zero commands"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: source cursor refuses UI/tick/prepare with zero commands"
        }
      ],
      "L01": [
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "persisted old failure → cold upgraded load → automatic preflight → original primary check → one same-target update/readback → review"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-04: exhausted A cannot veto independent B or donate/reset its counters"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-02: revision race and append failure never publish an owner; committed save failure fences dispatch and replays once"
        }
      ],
      "L02": [
        {
          "file": "tests/root-delivery-pipeline.test.cjs",
          "name": "real Agent loop: old Lark receipt → failed check → 19 sources → atomic rebind/reopen → six consumed reads → revise → verify → same Lark readback → review"
        },
        {
          "file": "tests/root-reading-revision.test.cjs",
          "name": "a verifier ignoring the concluding mode is bounded and cannot query platform boundaries"
        }
      ],
      "L03": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "L03: exhausted methods expose the specific unmet obligation and retry conditions without polling or invented readiness"
        }
      ],
      "pause-inflight": [
        {
          "file": "tests/system-pause-delivery.test.cjs",
          "name": "C13 controlled: pause during revised content check, cold restore, same-target delivery without old-counter handoff"
        },
        {
          "file": "tests/system-pending-check.test.cjs",
          "name": "P03: execution pause precedes legacy no-progress and preserves owner/counters"
        }
      ],
      "pause-claim-settle": [
        {
          "file": "tests/system-pending-check.test.cjs",
          "name": "pause-claim-settle: pause at each checkpoint survives cold start without a new opportunity"
        },
        {
          "file": "tests/root-repair-validation.test.cjs",
          "name": "real agent cold restart after claim without saved artifact never regenerates"
        },
        {
          "file": "tests/root-repair-validation.test.cjs",
          "name": "real agent cold restart after claim with saved artifact continues checking"
        },
        {
          "file": "tests/root-repair-validation.test.cjs",
          "name": "policy settles only the original consumed unknown claim once and preserves history after replay"
        }
      ],
      "restart-content-result": [
        {
          "file": "tests/input-upgrade-recovery.test.cjs",
          "name": "content and post-delivery result conclusions have independent bounded slots across a cold restart"
        },
        {
          "file": "tests/system-pause-delivery.test.cjs",
          "name": "C13 controlled: pause during revised content check, cold restore, same-target delivery without old-counter handoff"
        },
        {
          "file": "tests/system-pending-check.test.cjs",
          "name": "P03: generated output and check claim keep stable identity; settled check is not reissued"
        },
        {
          "file": "tests/root-continuation-actions.test.cjs",
          "name": "committed failed check counts once across restart before agent settlement"
        }
      ],
      "two-task-isolation": [
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-04: exhausted A cannot veto independent B or donate/reset its counters"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-04: dependency/resource/job-scoped legacy blockers continue to block B"
        },
        {
          "file": "tests/system-execution-policy.test.cjs",
          "name": "P1-04: two legal episodes select in stable task order and preserve the other owner"
        }
      ]
    },
    "testConcurrency": 4,
    "env": {
      "GENERIC_RECOVERY_FIXTURE_ROOT": "{historyRoot}/private-history/generic-recovery",
      "SYSTEM_HISTORY_SNAPSHOT_ROOT": "{historyRoot}",
      "GENERIC_RECOVERY_PERFORMANCE_REPORT": "{output}/generic-performance.json"
    }
  },
  "historicalReplay": {
    "tests": [
      "scripts/system-release-history-tests.cjs",
      "tests/history-report.test.cjs"
    ],
    "snapshots": {
      "S57": {
        "path": "{historyRoot}/private-history/S57",
        "completeness": "partial",
        "expectedOutcome": "unknownHistory"
      },
      "S62-input": {
        "path": "{historyRoot}/private-history/S62-input",
        "completeness": "complete",
        "expectedOutcome": "paused"
      },
      "S62-read": {
        "path": "{historyRoot}/private-history/S62-read",
        "completeness": "complete",
        "expectedOutcome": "paused"
      },
      "S63-after": {
        "path": "{historyRoot}/private-history/S63-after",
        "completeness": "complete",
        "expectedOutcome": "paused"
      }
    },
    "scenarioTests": {
      "S57": [
        {
          "file": "scripts/system-release-history-tests.cjs",
          "name": "[S57] preserved original facts and expected stopping point"
        }
      ],
      "S62-input": [
        {
          "file": "scripts/system-release-history-tests.cjs",
          "name": "[S62-input] preserved original facts and expected stopping point"
        }
      ],
      "S62-read": [
        {
          "file": "scripts/system-release-history-tests.cjs",
          "name": "[S62-read] preserved original facts and expected stopping point"
        }
      ],
      "S63-after": [
        {
          "file": "scripts/system-release-history-tests.cjs",
          "name": "[S63-after] preserved original facts and expected stopping point"
        }
      ],
      "S62-input-counterfactual": [
        {
          "file": "scripts/system-release-history-tests.cjs",
          "name": "[S62-input-counterfactual] preserved original facts and expected stopping point"
        }
      ],
      "S62-read-counterfactual": [
        {
          "file": "scripts/system-release-history-tests.cjs",
          "name": "[S62-read-counterfactual] preserved original facts and expected stopping point"
        }
      ],
      "S63-after-counterfactual": [
        {
          "file": "scripts/system-release-history-tests.cjs",
          "name": "[S63-after-counterfactual] preserved original facts and expected stopping point"
        }
      ]
    },
    "before": [
      {
        "script": "scripts/prepared-upgrade-history.cjs",
        "args": [
          "--snapshot",
          "{historyRoot}/private-history/prepared-upgrade",
          "--expected-digest",
          "PRIVATE_HISTORY_UNAVAILABLE",
          "--output",
          "{output}/prepared-upgrade-history.json"
        ],
        "timeoutMs": 1800000,
        "evidence": [
          "{output}/prepared-upgrade-history.json"
        ]
      }
    ],
    "testConcurrency": 4,
    "env": {
      "GENERIC_RECOVERY_FIXTURE_ROOT": "{historyRoot}/private-history/generic-recovery",
      "SYSTEM_HISTORY_SNAPSHOT_ROOT": "{historyRoot}",
      "GENERIC_RECOVERY_PERFORMANCE_REPORT": "{output}/generic-performance.json"
    }
  },
  "controlledWorker": {
    "tests": [
      "tests/system-controlled-worker.test.cjs",
      "tests/context-repair-delivery.test.cjs",
      "scripts/system-release-history-tests.cjs",
      "tests/generic-consumption-worker.test.cjs",
      "tests/generic-items-worker.test.cjs",
      "tests/model-preflight-worker.test.cjs",
      "tests/identity-scheduling-worker.test.cjs"
    ],
    "scenarioTests": {
      "full-delivery": [
        {
          "file": "tests/system-controlled-worker.test.cjs",
          "name": "controlled formal Worker: full-delivery check-revise"
        }
      ],
      "check-revise": [
        {
          "file": "tests/system-controlled-worker.test.cjs",
          "name": "controlled formal Worker: full-delivery check-revise"
        }
      ],
      "read-reorder": [
        {
          "file": "tests/system-controlled-worker.test.cjs",
          "name": "controlled formal Worker: read-reorder"
        }
      ],
      "read-mixed": [
        {
          "file": "tests/system-controlled-worker.test.cjs",
          "name": "controlled formal Worker: read-mixed"
        }
      ],
      "restart-content": [
        {
          "file": "tests/system-controlled-worker.test.cjs",
          "name": "controlled formal Worker: restart-content retains checkpoint and resumes same delivery"
        }
      ],
      "restart-result": [
        {
          "file": "tests/system-controlled-worker.test.cjs",
          "name": "controlled formal Worker: restart-result retains checkpoint and resumes same delivery"
        }
      ],
      "write-response-lost": [
        {
          "file": "tests/system-controlled-worker.test.cjs",
          "name": "controlled formal Worker: write-response-lost reconciles original action after process restart"
        }
      ],
      "readback-mismatch": [
        {
          "file": "tests/system-controlled-worker.test.cjs",
          "name": "controlled formal Worker: readback-mismatch stays unaccepted across restart without duplicate write"
        }
      ]
    },
    "before": [
      {
        "script": "scripts/generic-recovery-performance.cjs",
        "args": [
          "--output",
          "{output}/performance-g10.json",
          "--repetitions",
          "3"
        ],
        "timeoutMs": 600000,
        "evidence": [
          "{output}/performance-g10.json"
        ]
      }
    ],
    "testConcurrency": 4,
    "env": {
      "GENERIC_RECOVERY_FIXTURE_ROOT": "{historyRoot}/private-history/generic-recovery",
      "SYSTEM_HISTORY_SNAPSHOT_ROOT": "{historyRoot}",
      "GENERIC_RECOVERY_PERFORMANCE_REPORT": "{output}/generic-performance.json"
    }
  },
  "build": {
    "output": "release-candidate/行知助手-darwin-arm64/行知助手.app",
    "commands": [
      {
        "script": "scripts/release-build.cjs"
      }
    ]
  },
  "packageWorker": {
    "cases": [
      {
        "id": "package-worker-full-delivery",
        "script": "scripts/system-package-worker-matrix.cjs",
        "args": [
          "{package}",
          "{output}"
        ],
        "evidence": [
          "{output}/package-worker-matrix.json",
          "{output}/package-worker-success.json",
          "{output}/package-worker-pause_during_check.json",
          "{output}/package-worker-uncertain.json",
          "{output}/package-worker-readback_mismatch.json",
          "{output}/package-worker-context_authorization_repair.json",
          "{output}/package-worker-storage_method_recovery.json",
          "{output}/package-worker-generic_success.json",
          "{output}/package-worker-generic_uncertain.json",
          "{output}/package-worker-generic_mismatch.json",
          "{output}/package-worker-generic_preflight_recovery.json",
          "{output}/package-worker-generic_v2_recovery.json",
          "{output}/package-worker-generic_local_recovery.json"
        ],
        "evidenceDirectoriesFrom": [
          {
            "report": "{output}/package-worker-success.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-pause_during_check.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-uncertain.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-readback_mismatch.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-context_authorization_repair.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-storage_method_recovery.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-generic_success.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-generic_uncertain.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-generic_mismatch.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-generic_preflight_recovery.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-generic_v2_recovery.json",
            "field": "evidence"
          },
          {
            "report": "{output}/package-worker-generic_local_recovery.json",
            "field": "evidence"
          }
        ]
      }
    ],
    "before": [
      {
        "script": "scripts/model-preflight-package-worker.cjs",
        "args": [
          "--app",
          "{package}",
          "--output",
          "{output}/model-preflight-package-worker.json"
        ],
        "evidence": [
          "{output}/model-preflight-package-worker.json"
        ],
        "evidenceDirectoriesFrom": [
          {
            "report": "{output}/model-preflight-package-worker.json",
            "field": "evidence"
          }
        ],
        "timeoutMs": 600000
      },
      {
        "script": "scripts/identity-scheduling-package-worker.cjs",
        "args": [
          "--app",
          "{package}",
          "--output",
          "{output}/identity-scheduling-package-worker.json"
        ],
        "evidence": [
          "{output}/identity-scheduling-package-worker.json"
        ],
        "evidenceDirectoriesFrom": [
          {
            "report": "{output}/identity-scheduling-package-worker.json",
            "field": "evidence"
          }
        ],
        "timeoutMs": 600000
      }
    ],
    "testConcurrency": 4,
    "env": {
      "GENERIC_RECOVERY_FIXTURE_ROOT": "{historyRoot}/private-history/generic-recovery",
      "SYSTEM_HISTORY_SNAPSHOT_ROOT": "{historyRoot}",
      "GENERIC_RECOVERY_PERFORMANCE_REPORT": "{output}/generic-performance.json"
    }
  },
  "packageverify": {
    "tests": [
      "scripts/system-release-package-tests.cjs"
    ],
    "scenarioTests": {
      "package-source-match": [
        {
          "file": "scripts/system-release-package-tests.cjs",
          "name": "package-source-match"
        }
      ],
      "package-native": [
        {
          "file": "scripts/system-release-package-tests.cjs",
          "name": "package-native"
        }
      ],
      "package-signature": [
        {
          "file": "scripts/system-release-package-tests.cjs",
          "name": "package-signature"
        }
      ]
    },
    "testConcurrency": 4,
    "env": {
      "GENERIC_RECOVERY_FIXTURE_ROOT": "{historyRoot}/private-history/generic-recovery",
      "SYSTEM_HISTORY_SNAPSHOT_ROOT": "{historyRoot}",
      "GENERIC_RECOVERY_PERFORMANCE_REPORT": "{output}/generic-performance.json"
    }
  },
  "requirements": [
    "ENG-CHECK",
    "APP-010",
    "APP-008",
    "ENG-RELEASE",
    "ENG-METRICS"
  ]
};
function generate({historyRoot,fixtureRoot,requirements=template.requirements}={}) {
  if (!historyRoot || !path.isAbsolute(historyRoot)) throw Error('HISTORY_ROOT_REQUIRED: provide a read-only historical-fixture root');
  if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) throw Error('FIXTURE_ROOT_REQUIRED: provide the generic recovery fixture root');
  const plan=JSON.parse(JSON.stringify(template).replaceAll('{historyRoot}',historyRoot.replaceAll('\\','\\\\')));
  plan.requirements=structuredClone(requirements);
  for(const group of Object.values(plan))if(group && typeof group==='object' && group.env)group.env.GENERIC_RECOVERY_FIXTURE_ROOT=fixtureRoot;
  require('./system-release-gate.cjs').validatePlan(plan);
  return plan;
}
module.exports={generate};
