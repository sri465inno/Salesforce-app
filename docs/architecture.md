# Architecture

```
            ┌─────────────────────────── Platform (npm start, 127.0.0.1:3000) ───────────────────────────┐
 Browser ──►│ src/ui (Home, Run, Human Review, Cycle Details, Test Data, Execution, Reporting, Lab, Audit)│
            │        │ REST /api/*                                                                        │
            │ src/platform/app.ts ──► Pipeline (pipeline.ts) ──► agents/* ──► Store (store.ts, AQE_HOME)   │
            │                               │ 4 human gates        │ Test Lab (lab.ts)                    │
            └───────────────────────────────┼──────────────────────┼──────────────────────────────────────┘
                                            ▼ execution (after Gate 3 approval)
                  Playwright (generated specs) ──► Demo service (src/demo-service, random loopback port)
                                                    Express + GraphQL (contracts/reservation.graphql)
                                                    LWC-style console · Node port of Apex validator/service
```

## Layers

| Layer | Salesforce model | Runnable local equivalent |
|---|---|---|
| Data | `force-app/.../objects/Reservation__c` | in-memory `ReservationService` |
| Business logic | `ReservationValidator.cls`, `ReservationService.cls` | `src/demo-service/reservation-validator.ts`, `reservation-service.ts` |
| API | `ReservationController.cls` (Aura/LWC) | `/graphql` implementing `contracts/reservation.graphql` |
| UI | `lwc/createReservation`, `reservationSearch`, `reservationManage` | `src/demo-service/ui` (same fields, `data-testid`s) |

Both validator implementations carry `@rule BR-00x <CODE>` markers; `npm run record:source-refs` indexes them
into `fixtures/inputs/source-code-references.json` (sha256 per file), which the Review Agent uses to find
code-only rules and the Defect Agent uses to point at the suspected code line.

## Persistence and resume

`Store` writes JSON atomically under `AQE_HOME` (default `demo-artifacts/`):

```
state/cycles/CYC-*.json   cycle + stage status, approvals        state/baselines/BL-*.json  final baselines
state/lab/LAB-*.json      Test Lab runs                           audit/audit.jsonl          append-only audit
cycles/CYC-*/{inputs,requirements,review,rules,tests,data,automation,execution,defects,reports,traceability}
lab/LAB-*/{automation,execution}
```

Each stage is marked `running` before work and `completed` after. On platform start, `recoverInterrupted()`
turns leftover `running` stages into `interrupted`; **Resume** re-runs only those stages. `AQE_SIMULATE_CRASH_AT=<stage>`
kills the process at a stage (used by `tests/acceptance/resume.spec.ts`).

## Execution

The Execution Agent starts the demo service (seeded or fixed build) on port 0, runs `playwright test` on the
generated suite with `AQE_BASE_URL`, JSON reporter and `trace: on`, then copies screenshots, traces,
request/response captures and per-test service-log slices into `execution/evidence/<TC>/`, masking text
evidence. Results map back to test cases by the `@TC-xxx` tag in each spec title.

## Release policy (deterministic)

| Rule | Check | If failed |
|---|---|---|
| RP-1 | generated tests were executed | Not ready |
| RP-2 | gates 1–3 approved by a human | Not ready |
| RP-3 | privacy and secret-scan checks passed | No-go |
| RP-4 | no open critical/high defects | No-go |
| RP-5 | every P1 test passed | No-go |
| RP-6 | every business rule verified by a passing test | Conditional go |
| RP-7 | no non-blocking defects, no unaccepted high review findings | Conditional go |

Most severe outcome wins (Not ready > No-go > Conditional go); otherwise Go. A human signs off at Gate 4.
