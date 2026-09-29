# Defect report CYC-0001

## DEF-001 — BR-002 not enforced: customerCount = 0 is accepted by createReservation

- Severity: **high** (blocks release); status open; created from execution-failure
- Rule: [BR-002](/#/trace/CYC-0001/BR-002); requirements: [REQ-004](/#/trace/CYC-0001/REQ-004), [REQ-009](/#/trace/CYC-0001/REQ-009), [REQ-012](/#/trace/CYC-0001/REQ-012)
- Test cases: [TC-004](/#/trace/CYC-0001/TC-004), [TC-005](/#/trace/CYC-0001/TC-005); executions: [EX-TC-004](/#/trace/CYC-0001/EX-TC-004), [EX-TC-005](/#/trace/CYC-0001/EX-TC-005)
- Evidence: [EV-TC-004-01](/#/trace/CYC-0001/EV-TC-004-01), [EV-TC-004-02](/#/trace/CYC-0001/EV-TC-004-02), [EV-TC-004-03](/#/trace/CYC-0001/EV-TC-004-03), [EV-TC-004-04](/#/trace/CYC-0001/EV-TC-004-04), [EV-TC-004-05](/#/trace/CYC-0001/EV-TC-004-05), [EV-TC-005-01](/#/trace/CYC-0001/EV-TC-005-01), [EV-TC-005-02](/#/trace/CYC-0001/EV-TC-005-02), [EV-TC-005-03](/#/trace/CYC-0001/EV-TC-005-03), [EV-TC-005-04](/#/trace/CYC-0001/EV-TC-005-04), [EV-TC-005-05](/#/trace/CYC-0001/EV-TC-005-05)
- Expected: Customer count must be greater than zero. createReservation returns success=false with error INVALID_CUSTOMER_COUNT when customerCount = 0 (TC-004 API, TC-005 UI).
- Actual: createReservation returned success=true, status CONFIRMED, confirmation number CNF-XBJ6ST38.
- Impact: Reservation records that violate BR-002 (customerCount > 0 and customerCount <= 10 (data dictionary)) are confirmed and receive a confirmation number, so fulfilment and occupancy reporting receive invalid reservations. Reproduced through API and UI in 2 test(s).
- Suspected cause: Boundary value 0 for customerCount passes validation. The rule is enforced in validateCustomerCount (src/demo-service/reservation-validator.ts:82) by `if (count === undefined || count === null || !Number.isInteger(count) || count < lowerBound || count > 10) {`; the lower bound admits 0 although BR-002 requires customerCount > 0.
- Suggested remediation: Reject customerCount <= 0 in validateCustomerCount (lower bound 1) and apply the same fix to force-app/main/default/classes/ReservationValidator.cls:61; then re-run TC-004, TC-005.

```
// src/demo-service/reservation-validator.ts:82
export function validateCustomerCount(input: CreateReservationInput, errors: ValidationError[], options: ValidatorOptions = {}): void {
  const count = input.customerCount;
  const lowerBound = options.fixedDefects?.includes('BR-002') ? 1 : 0;
  if (count === undefined || count === null || !Number.isInteger(count) || count < lowerBound || count > 10) {
    errors.push({ code: 'INVALID_CUSTOMER_COUNT', field: 'customerCount', message: 'Customer count must be between 1 and 10', ruleId: 'BR-002' });
  }
}

```

