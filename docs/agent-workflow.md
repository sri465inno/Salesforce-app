# Agent workflow

| # | Stage | Agent | Output (under `cycles/<id>/`) |
|---|---|---|---|
| 1 | Load inputs | Intake | `inputs/*.json`, `inputs/manifest.json` (sha256, `recordedFrom`; missing provenance is rejected) |
| 2 | Normalize requirements | Requirements Agent | `requirements/draft.json` — versioned REQ-xxx with source path/pointer and hash; incremental runs add `requirements/changes.json` |
| 3 | Review | Review Agent | `review/findings.json` — duplicates, conflicts, missing criteria, code-only rules, each with evidence and a recommendation. Advisory only |
| G1 | **Requirements baseline** | human | every finding decided (accept/reject/defer); only accepted findings change `requirements/baseline.json` |
| 4 | Extract business rules | Business Rules Agent | `rules/business-rules.json` — kind (validation/constraint/decision/outcome), condition, expected outcome, source requirements, code references |
| 5 | Design tests | Test Design Agent | `tests/test-cases.json` (smoke, positive, negative, boundary, e2e × UI/API) and `tests/coverage-matrix.json` |
| G2 | **Test cases and coverage** | human | |
| 6 | Generate data | Test Data Agent | `data/datasets.json` — one deterministic SYNTHETIC dataset per test case (seeded by test-case id), validated against the dictionary and privacy rules |
| 7 | Generate automation | Automation Agent | `automation/` — Playwright config, fixtures (`support/aqe.ts`), page object, one spec per test case with requirement/rule/dataset header |
| G3 | **Automation execution** | human | nothing executes before this approval |
| 8 | Execute | Execution Agent | `execution/summary.json`, masked Playwright report/log, `execution/evidence/<TC>/` |
| 9 | Defects | Defect Intelligence Agent | `defects/DEF-xxx.json` — only from `status === 'failed'` results, grouped by rule |
| 10 | Report | Reporting Agent | `reports/*` (cycle, coverage, execution summary, defect, release readiness, QE lead, executive dashboard, metrics) and `traceability/traceability.{json,xlsx}` |
| G4 | **Final baseline and release** | human | writes `state/baselines/BL-xxx.json` |

Agents never approve: `validateApprover` rejects empty/short names and names matching agent/bot/system/AI
patterns or any agent name. Every approval records approver, timestamp, decision, comments and (Gate 1)
finding decisions, in the cycle and in `audit/audit.jsonl`. Rejections require comments and stop the cycle.

## Test Lab

`POST /api/lab { scenario, approver }` → `interpretScenario` maps phrases to a mutation using data-dictionary
aliases and patterns → the dictionary decides whether the data is invalid → the matching rule and its source
requirements are chosen from the latest baseline → test case, SYNTHETIC dataset and spec are generated → the
named human's approval is audited → the spec runs against the seeded demo service → defects are created from
real failures → the chain (requirement → rule → test case → dataset → script → execution → evidence → defect)
is returned and shown. Contradictory scenarios (e.g. "count 3 should be rejected") are blocked before execution.
