# Data model

Source of truth: `fixtures/inputs/data-dictionary.json` (all values synthetic).

## Reservation

| Field | Type | Rules |
|---|---|---|
| reservationId | ID (`RSV-SYN-…`) | system generated |
| confirmationNumber | `CNF-[A-Z0-9]{8}` | generated on success (BR-005) |
| locationId | `LOC-SYN-00x`, must be active | BR-003 |
| startDate / endDate | ISO date, start < end | BR-001 |
| customerCount | integer 1–10 | BR-002 (seeded build accepts 0) |
| resourceType | STANDARD_ROOM, SUITE, CONFERENCE_ROOM; must be available | BR-007 |
| status | CONFIRMED, MODIFIED, CANCELLED | |
| createdAt | ISO timestamp | |

## Customer

| Field | Rules |
|---|---|
| customerId | `CUS-SYN-…`, generated |
| firstName, lastName | required (BR-006); synthetic name lists, masked in evidence |
| email | required (BR-006), format (BR-D01), `@example.test` only |

## Payment

| Field | Rules |
|---|---|
| paymentMethod | CARD_TOKEN or INVOICE approved (BR-004); CASH, GIFT_VOUCHER rejected |
| paymentToken | `tok_synthetic_[a-z0-9]{12}` placeholder, never a card number; stored and logged masked |
| authorizationStatus | AUTHORIZED / PENDING / DECLINED from the mock gateway (BR-D02) |

## Platform records

`Requirement`, `BusinessRule`, `TestCase`, `Dataset` (classification, version, provenance, validation),
`AutomationScript` (file, sha256), `ExecutionResult` + `EvidenceItem`, `Defect`, `Approval`, `AuditEntry`,
`Cycle`/`Stage` — see `src/platform/types.ts`. The trace graph (`src/platform/bundle.ts`) links them with
`up`/`down` edges; the JSON and Excel exports flatten it to one row per requirement/rule/test case.
