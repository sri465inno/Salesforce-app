/** Demo reservation service: create / search / modify / cancel / validate over GraphQL and the LWC-style console, plus the seeded BR-002 defect. */
import { test, expect } from '@playwright/test';
import { startDemoService } from '../../src/demo-service/app';

type Svc = Awaited<ReturnType<typeof startDemoService>>;
const input = (over: Record<string, unknown> = {}) => ({
  locationId: 'LOC-SYN-001', startDate: '2027-05-01', endDate: '2027-05-04', customerCount: 2, resourceType: 'STANDARD_ROOM',
  customer: { firstName: 'Avery', lastName: 'Synthwell', email: 'avery.synthwell@example.test' },
  payment: { paymentMethod: 'CARD_TOKEN', paymentToken: 'tok_synthetic_a1b2c3d4e5f6' },
  ...over,
});
const FIELDS = 'confirmationNumber status customerCount endDate payment { paymentToken authorizationStatus }';
async function gql<T>(svc: Svc, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${svc.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const body = (await res.json()) as { data: T; errors?: unknown[] };
  expect(body.errors).toBeUndefined();
  return body.data;
}
const CREATE = `mutation($input: CreateReservationInput!) { createReservation(input: $input) { success errors { code ruleId } reservation { ${FIELDS} } } }`;
interface Payload { success: boolean; errors: { code: string; ruleId: string }[]; reservation: { confirmationNumber: string; status: string; customerCount: number; endDate: string; payment: { paymentToken: string; authorizationStatus: string } } | null }

test.describe('seeded build', () => {
  let svc: Svc;
  test.beforeAll(async () => (svc = await startDemoService(0)));
  test.afterAll(async () => svc.close());

  test('create, search, modify and cancel a reservation over GraphQL', async () => {
    const { createReservation: c } = await gql<{ createReservation: Payload }>(svc, CREATE, { input: input() });
    expect(c.success).toBe(true);
    const cnf = c.reservation!.confirmationNumber;
    expect(cnf).toMatch(/^CNF-[A-Z0-9]{8}$/);
    expect(c.reservation!.payment.paymentToken).not.toContain('a1b2c3d4e5f6'.slice(0, 8));
    const { searchReservations } = await gql<{ searchReservations: { confirmationNumber: string }[] }>(svc, 'query($f: ReservationSearchInput!) { searchReservations(filter: $f) { confirmationNumber } }', { f: { lastName: 'Synthwell' } });
    expect(searchReservations.map((r) => r.confirmationNumber)).toContain(cnf);
    const { modifyReservation: m } = await gql<{ modifyReservation: Payload }>(svc, `mutation($i: ModifyReservationInput!) { modifyReservation(input: $i) { success errors { code ruleId } reservation { ${FIELDS} } } }`, { i: { confirmationNumber: cnf, customerCount: 3, endDate: '2027-05-05' } });
    expect(m.success).toBe(true);
    expect(m.reservation).toMatchObject({ customerCount: 3, endDate: '2027-05-05' });
    const { cancelReservation: x } = await gql<{ cancelReservation: Payload }>(svc, `mutation($c: String!) { cancelReservation(confirmationNumber: $c, reason: "Customer request") { success reservation { ${FIELDS} } } }`, { c: cnf });
    expect(x.reservation!.status).toBe('CANCELLED');
  });

  test('business rules BR-001, BR-003, BR-004, BR-006, BR-007 are enforced', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ startDate: '2027-05-04', endDate: '2027-05-01' }, 'BR-001'],
      [{ locationId: 'LOC-SYN-004' }, 'BR-003'],
      [{ payment: { paymentMethod: 'CASH', paymentToken: 'tok_synthetic_a1b2c3d4e5f6' } }, 'BR-004'],
      [{ customer: { firstName: 'Avery', lastName: null, email: 'avery@example.test' } }, 'BR-006'],
      [{ locationId: 'LOC-SYN-002', resourceType: 'SUITE', startDate: '2027-03-11', endDate: '2027-03-12' }, 'BR-007'],
    ];
    for (const [over, rule] of cases) {
      const { createReservation: c } = await gql<{ createReservation: Payload }>(svc, CREATE, { input: input(over) });
      expect(c.success, rule).toBe(false);
      expect(c.errors.map((e) => e.ruleId), rule).toContain(rule);
    }
  });

  test('validates customer and payment information', async () => {
    const q = 'query($c: CustomerInput!, $p: PaymentInput!) { validateCustomer(customer: $c) { valid errors { code } } validatePayment(payment: $p) { valid authorizationStatus } }';
    const ok = await gql<{ validateCustomer: { valid: boolean }; validatePayment: { valid: boolean; authorizationStatus: string } }>(svc, q, { c: input().customer, p: input().payment });
    expect(ok.validateCustomer.valid).toBe(true);
    expect(ok.validatePayment).toMatchObject({ valid: true, authorizationStatus: 'AUTHORIZED' });
    const bad = await gql<{ validateCustomer: { valid: boolean }; validatePayment: { valid: boolean; authorizationStatus: string } }>(svc, q, { c: { firstName: 'A', lastName: 'B', email: 'not-an-email' }, p: { paymentMethod: 'CARD_TOKEN', paymentToken: 'tok_synthetic_decline0001' } });
    expect(bad.validateCustomer.valid).toBe(false);
    expect(bad.validatePayment.authorizationStatus).toBe('DECLINED');
  });

  test('seeded defect: customerCount = 0 is accepted; the service log is masked', async () => {
    const { createReservation: c } = await gql<{ createReservation: Payload }>(svc, CREATE, { input: input({ customerCount: 0 }) });
    expect(c.success).toBe(true);
    const log = await (await fetch(`${svc.url}/__log`)).text();
    expect(log).not.toContain('tok_synthetic_a1b2c3d4e5f6');
    expect(log).not.toContain('avery.synthwell@example.test');
  });

  test('LWC-style console creates a reservation and shows the confirmation number', async ({ page }) => {
    await page.goto(svc.url);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    const v = input();
    await page.getByTestId('locationId').selectOption(v.locationId);
    await page.getByTestId('startDate').fill(v.startDate);
    await page.getByTestId('endDate').fill(v.endDate);
    await page.getByTestId('customerCount').fill('2');
    await page.getByTestId('firstName').fill(v.customer.firstName);
    await page.getByTestId('lastName').fill(v.customer.lastName);
    await page.getByTestId('email').fill(v.customer.email);
    await page.getByTestId('paymentMethod').selectOption('CARD_TOKEN');
    await page.getByTestId('paymentToken').fill(v.payment.paymentToken);
    await page.getByTestId('submit-create').click();
    await expect(page.getByTestId('success-toast')).toContainText(/CNF-[A-Z0-9]{8}/);
  });
});

test('fixed build rejects customerCount = 0 with INVALID_CUSTOMER_COUNT (BR-002)', async () => {
  const svc = await startDemoService(0, { fixedDefects: ['BR-002'] });
  try {
    const { createReservation: c } = await gql<{ createReservation: Payload }>(svc, CREATE, { input: input({ customerCount: 0 }) });
    expect(c.success).toBe(false);
    expect(c.errors).toContainEqual({ code: 'INVALID_CUSTOMER_COUNT', ruleId: 'BR-002' });
  } finally {
    await svc.close();
  }
});
