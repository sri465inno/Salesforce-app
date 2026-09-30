# Agentic QE Platform — Salesforce reservation management (local MVP)

A locally runnable Agentic Quality Engineering platform that takes one user story (STORY-001, *create a
customer reservation*) through the complete QE lifecycle against a lightweight Salesforce-style demo app:

```
Requirement → Business Rule → Test Case → Test Data → Automation → Execution → Evidence → Defect → Report
```

Nine deterministic agents do the work; **four human gates** decide. Tests are generated as real Playwright
TypeScript specs (UI + GraphQL), executed against a local demo service that carries an intentional defect
(`customerCount = 0` is accepted, violating BR-002). The failure becomes a traceable defect, the Reporting
Agent computes metrics in code and applies a rules-based release policy (No-go), and every report row links
back to the defect, evidence, execution, script, dataset, test case, rule and original requirement.

This is **not** a production reservation system and does **not** need a Salesforce org, Jira, credentials or any
paid service. All data is SYNTHETIC and stays on `127.0.0.1`.

## Quick start

Requirements: Node.js **20+** (Playwright 1.63 requires Node ≥ 20; see Limitations), npm, ~500 MB for Chromium.

```bash
npm install
npx playwright install chromium     # once; add --with-deps on a fresh Linux box
npm run demo                        # full lifecycle, headless, writes demo-artifacts/
npm start                           # platform UI on http://127.0.0.1:3000
```

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm start` | Build and start the platform (UI + API) on `127.0.0.1:3000` (`PORT` overrides) |
| `npm run start:demo-service` | Start only the demo reservation app on `127.0.0.1:4100` (`DEMO_SERVICE_PORT` overrides; `DEMO_FIXED_DEFECTS=BR-002` for the fixed build) |
| `npm run demo` | Reset, then run a baseline cycle through all four gates with a named demo approver; add `-- --rerun-fixed` for a second cycle against the fixed build |
| `npm run artifacts` | Regenerate reports, traceability exports and `demo-artifacts/INDEX.md` for existing cycles |
| `npm run reset` | Delete local state, cycles and lab runs (per `aqe.config.json`); the audit log is kept and records the reset |
| `npm test` | Run the Playwright acceptance suite (`tests/acceptance`, 23 tests) |
| `npm run lint` | Typecheck (Node + browser projects) and ESLint |
| `npm run typecheck` / `npm run build` | TypeScript only / compile to `dist/` |
| `npm run scan:secrets` | Secret, credential and card-number scan of source, fixtures and generated artifacts (exit 1 on findings) |
| `npm run record:source-refs` | Re-index `@rule` markers in the Apex and Node sources into `fixtures/inputs/source-code-references.json` |

State lives in `demo-artifacts/` by default (`AQE_HOME` overrides). Tests use isolated `.aqe-test/<name>/` homes.

## Demo guide (Definition of Done, step by step)

### Headless (2 minutes)

```bash
npm run demo -- --rerun-fixed
```

Expected output (abridged):

```
CYC-0001 created (baseline, seeded build)
  Review Agent: 5 advisory findings
  Gate 1 approved -> 22 test cases designed
  Gate 2 approved -> 22 synthetic datasets and Playwright specs generated
  Gate 3 approved -> executing Playwright suite...
  Execution: 20/22 passed, 2 failed; defects: 1
  Recommendation (rules-based): No-go — RP-4 failed ... (DEF-001 (high)) RP-5 failed ... (TC-004, TC-005)
  Gate 4 signed off -> final baseline BL-0001
CYC-0002 created (baseline, fixed build: BR-002)
  Execution: 22/22 passed, 0 failed; defects: 0
  Recommendation (rules-based): Go — Every release policy rule passed.
```

Then open `demo-artifacts/INDEX.md`, or `npm start` and browse the cycles.

### In the UI

1. `npm start`, open http://127.0.0.1:3000 — **Home** shows the agent model, gates and lineage.
2. **Run** → enter your name → *Baseline* → keep all testing types/inputs/skills → **Start cycle**.
   (1) Inputs load (initiative, epic, STORY-001, business rules, GraphQL contract, data dictionary, source-code
   references) with sha256 provenance.
3. **Human Review, Gate 1** — requirements, the Review Agent's 5 advisory findings (duplicate AC, 12-vs-10
   customer conflict, missing BR-007 criterion, two code-only rules). *Approve* stays disabled until every
   finding has a decision; approvals by names like "Review Agent" are refused. (2) Approve.
4. **Gate 2** — (3) business rules BR-001…BR-007 (+ accepted code-only BR-D01/BR-D02) each linked to source
   requirements and code lines; (4) 22 smoke/positive/negative/boundary/e2e test cases (UI + API) and the
   coverage matrix. Approve.
5. **Gate 3** — (5) 22 SYNTHETIC datasets (see **Test Data**: validation, version, provenance, linked test
   case, and a *probe* that shows an unknown-provenance dataset being rejected); (6) 22 generated Playwright
   specs. (7) Approve execution — nothing runs before this.
6. (8) The Execution Agent starts the demo service on a random loopback port and runs Playwright.
   **Execution** shows results, (10) screenshots, traces, request/response and service logs (masked), and
   (9, 11) `DEF-001` created from the actual `TC-004`/`TC-005` failures (expected rejection, actual
   `success=true` + confirmation number, severity high, impact, suspected cause at
   `src/demo-service/reservation-validator.ts`, remediation).
7. (12) **Reporting** — coverage, pass rate, defects, approvals, risks, privacy checks and the policy table
   → **No-go**. Links: QE lead report, executive dashboard, JSON and Excel traceability.
8. (13) In *Traceability*, search `DEF-001` → click it → the trace view walks upstream:
   defect → evidence → execution → script → dataset → test case → BR-002 → REQ-004 (and the report links to
   the defect). Every ID is clickable.
9. **Gate 4** — sign off the final baseline and recommendation (comments are required for a rejection).
10. **Test Lab** — type e.g. *"A reservation with customer count 0 should be rejected"*, enter your name
    (approves execution) and run: a test case, SYNTHETIC dataset and Playwright spec are generated, executed,
    and the full chain requirement → … → defect is displayed.
11. **Audit Log** — approvals, executions, access, lab, retention, deletion and reset entries.
12. Optional: **Run** again with *Run against the fixed service build* → all tests pass → **Go**.

## Architecture

See [docs/architecture.md](docs/architecture.md), [docs/agent-workflow.md](docs/agent-workflow.md) and
[docs/data-model.md](docs/data-model.md).

```
fixtures/inputs/            recorded inputs (initiative, epic, story, rules, contract, dictionary, source refs)
contracts/reservation.graphql  GraphQL contract
force-app/main/default/     Salesforce DX-style metadata: Reservation__c, Apex service/validator/controller, LWCs
src/demo-service/           runnable Node port: Express + GraphQL + LWC-style console (seeded BR-002 defect)
src/platform/agents/        the nine agents (+ execution/defects/reporting)
src/platform/pipeline.ts    stages, four human gates, persistence, resume
src/platform/app.ts         local REST API + static UI; src/ui/ is the platform UI (8 screens + audit)
src/platform/lab.ts         Test Lab
src/platform/privacy.ts     secret/card scanning; src/shared/mask.ts masking; src/platform/retention.ts
scripts/                    demo, reset, scan-secrets, record-source-refs
tests/acceptance/           Playwright acceptance tests for the critical workflows
demo-artifacts/             committed output of `npm run demo -- --rerun-fixed`
```

## Privacy and security controls

| Control | Where |
|---|---|
| Synthetic data only; every dataset `classification: SYNTHETIC`, `example.test` emails, synthetic names | `src/platform/agents/test-data.ts`, data dictionary |
| No card numbers; payment tokens are `tok_synthetic_<12>` placeholders; Luhn scan fails the build on any card-like number | `src/platform/privacy.ts` |
| Unknown provenance rejected (generator must be in `approvedDatasetGenerators`) before automation/execution | `assertProvenance`, `POST /api/datasets/validate` |
| Masking of emails, names, tokens, bearer values and card-like digits in service logs, evidence, Playwright reports, defects, reports, API responses; `data-sensitive` fields masked in screenshots (Playwright `mask`) | `src/shared/mask.ts`, `src/platform/agents/execution.ts` |
| Secret scan of generated code and artifacts on every reporting run (RP-3) and via `npm run scan:secrets` | `src/platform/privacy.ts` |
| No hardcoded credentials; nothing external is called; servers bind `127.0.0.1` | `src/platform/app.ts`, `src/demo-service/app.ts` |
| Audit log (JSONL) for approvals, executions, access, lab runs, retention, deletion and reset | `demo-artifacts/audit/audit.jsonl` |
| Configurable retention and deletion: `evidenceRetentionDays`, `deleteEvidenceOnReset` in `aqe.config.json` (`AQE_EVIDENCE_RETENTION_DAYS`); *Apply retention* on the Audit screen, `DELETE /api/cycles/:id/evidence` | `src/platform/retention.ts` |
| Agents recommend, humans decide: approver names resembling agents/bots/systems are rejected | `validateApprover` in `src/platform/pipeline.ts` |

## Limitations

- Salesforce artefacts (`force-app/`) are structurally faithful but not deployed or executed; the runnable
  service is a Node port of the Apex validator/service, kept in sync via `@rule` markers.
- Agents are deterministic rule/pattern engines, not LLMs. The Test Lab understands phrasing built from the
  data-dictionary aliases and a fixed set of patterns (dates, counts, locations, payment methods, missing
  fields, availability, UI/API hints); anything else is interpreted conservatively or blocked.
- Single-user local tool: no authentication; the approver name is self-declared (recorded, and agent names
  rejected), which is adequate for a demo but not for real segregation of duties.
- Demo-service data is in memory and reset on each execution run.
- Node 18 is not supported: the required Playwright 1.63 declares `node >= 20`.
- Only STORY-001 is in scope; STORY-002…004 in the epic are placeholders.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `browserType.launch: Executable doesn't exist` | `npx playwright install chromium` (Linux: `npx playwright install --with-deps chromium`) |
| `EADDRINUSE :3000` | `PORT=3100 npm start` |
| Cycle shows *interrupted* after a restart | Open Cycle Details or Run → **Resume**; completed stages are kept |
| Gate 1 *Approve* disabled | Every review finding needs Accept/Reject/Defer |
| "Agents may recommend but cannot approve" | Use a human name as approver |
| `npm run scan:secrets` exits 1 | Remove or mask the reported value; never commit real credentials |
| Start over | `npm run reset` (or delete `demo-artifacts/` and run `npm run demo`) |
