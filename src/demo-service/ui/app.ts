/* Browser controller for the demo reservation console (Lightning-style, no framework). */
interface GqlError { code: string; field: string | null; message: string; ruleId: string | null }
interface ReservationView { confirmationNumber: string; locationId: string; startDate: string; endDate: string; customerCount: number; status: string }
interface Payload { success: boolean; reservation: ReservationView | null; errors: GqlError[] }

const RESERVATION_FIELDS = 'reservationId confirmationNumber locationId startDate endDate customerCount resourceType status createdAt';

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function show(target: string, payload: Payload, successText: (r: ReservationView) => string) {
  const el = $<HTMLElement>(target);
  if (payload.success && payload.reservation) {
    el.innerHTML = `<div class="toast success" data-testid="success-toast">${successText(payload.reservation)}</div>`;
  } else {
    el.innerHTML = `<div class="toast error" data-testid="error-toast">Reservation was not saved<ul>${payload.errors
      .map((e) => `<li data-testid="error" data-code="${esc(e.code)}" data-rule="${esc(e.ruleId)}">${esc(e.message)}</li>`)
      .join('')}</ul></div>`;
  }
}

function formValues(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(Array.from(new FormData(form).entries()).map(([k, v]) => [k, String(v)]));
}

function setupTabs() {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab));
    }),
  );
}

async function init() {
  setupTabs();
  const build = await fetch('/__build').then((r) => r.json() as Promise<{ build: string }>);
  $<HTMLElement>('#build').textContent = build.build;
  const { locations } = await gql<{ locations: { locationId: string; name: string; active: boolean }[] }>('query Locations { locations { locationId name active } }', {});
  const select = $<HTMLSelectElement>('[data-testid="locationId"]');
  for (const l of locations) select.insertAdjacentHTML('beforeend', `<option value="${esc(l.locationId)}">${esc(l.locationId)} — ${esc(l.name)}${l.active ? '' : ' (inactive)'}</option>`);
  document.body.dataset.ready = 'true';

  $<HTMLFormElement>('#create-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = formValues(ev.target as HTMLFormElement);
    const input = {
      locationId: v.locationId || null,
      resourceType: v.resourceType || null,
      startDate: v.startDate || null,
      endDate: v.endDate || null,
      customerCount: v.customerCount === '' ? null : Number(v.customerCount),
      customer: { firstName: v['customer.firstName'], lastName: v['customer.lastName'], email: v['customer.email'] },
      payment: { paymentMethod: v['payment.paymentMethod'] || null, paymentToken: v['payment.paymentToken'] },
    };
    const data = await gql<{ createReservation: Payload }>(
      `mutation CreateReservation($input: CreateReservationInput!) { createReservation(input: $input) { success errors { code field message ruleId } reservation { ${RESERVATION_FIELDS} } } }`,
      { input },
    );
    show('#create-result', data.createReservation, (r) => `Reservation confirmed. Confirmation number: <strong data-testid="confirmation-number">${esc(r.confirmationNumber)}</strong> (status <span data-testid="reservation-status">${esc(r.status)}</span>, customers ${esc(r.customerCount)})`);
  });

  $<HTMLFormElement>('#search-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = formValues(ev.target as HTMLFormElement);
    const data = await gql<{ searchReservations: ReservationView[] }>(
      `query Search($filter: ReservationSearchInput!) { searchReservations(filter: $filter) { ${RESERVATION_FIELDS} } }`,
      { filter: { confirmationNumber: v.confirmationNumber || null, lastName: v.lastName || null } },
    );
    $<HTMLElement>('[data-testid="search-results"] tbody').innerHTML = data.searchReservations
      .map((r) => `<tr data-testid="search-row"><td>${esc(r.confirmationNumber)}</td><td>${esc(r.locationId)}</td><td>${esc(r.startDate)}</td><td>${esc(r.endDate)}</td><td>${esc(r.customerCount)}</td><td data-testid="row-status">${esc(r.status)}</td></tr>`)
      .join('') || '<tr><td colspan="6" data-testid="no-results">No reservations found</td></tr>';
  });

  $<HTMLFormElement>('#modify-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = formValues(ev.target as HTMLFormElement);
    const data = await gql<{ modifyReservation: Payload }>(
      `mutation Modify($input: ModifyReservationInput!) { modifyReservation(input: $input) { success errors { code field message ruleId } reservation { ${RESERVATION_FIELDS} } } }`,
      { input: { confirmationNumber: v.confirmationNumber, endDate: v.endDate || null, customerCount: v.customerCount === '' ? null : Number(v.customerCount) } },
    );
    show('#manage-result', data.modifyReservation, (r) => `Reservation ${esc(r.confirmationNumber)} modified (status <span data-testid="reservation-status">${esc(r.status)}</span>)`);
  });

  $<HTMLFormElement>('#cancel-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const confirmationNumber = $<HTMLInputElement>('[data-testid="manage-confirmation"]').value;
    const reason = formValues(ev.target as HTMLFormElement).reason || null;
    const data = await gql<{ cancelReservation: Payload }>(
      `mutation Cancel($confirmationNumber: String!, $reason: String) { cancelReservation(confirmationNumber: $confirmationNumber, reason: $reason) { success errors { code field message ruleId } reservation { ${RESERVATION_FIELDS} } } }`,
      { confirmationNumber, reason },
    );
    show('#manage-result', data.cancelReservation, (r) => `Reservation ${esc(r.confirmationNumber)} cancelled (status <span data-testid="reservation-status">${esc(r.status)}</span>)`);
  });

  $<HTMLFormElement>('#validate-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = formValues(ev.target as HTMLFormElement);
    const data = await gql<{ validateCustomer: { valid: boolean; errors: GqlError[] }; validatePayment: { valid: boolean; errors: GqlError[]; authorizationStatus: string } }>(
      `query Validate($customer: CustomerInput!, $payment: PaymentInput!) { validateCustomer(customer: $customer) { valid errors { code message ruleId } } validatePayment(payment: $payment) { valid authorizationStatus errors { code message ruleId } } }`,
      { customer: { firstName: v.firstName, lastName: v.lastName, email: v.email }, payment: { paymentMethod: v.paymentMethod, paymentToken: v.paymentToken } },
    );
    const errors = [...data.validateCustomer.errors, ...data.validatePayment.errors];
    $<HTMLElement>('#validate-result').innerHTML = errors.length
      ? `<div class="toast error" data-testid="error-toast"><ul>${errors.map((e) => `<li data-testid="error" data-code="${esc(e.code)}">${esc(e.message)}</li>`).join('')}</ul></div>`
      : `<div class="toast success" data-testid="success-toast">Customer valid. Payment ${esc(data.validatePayment.authorizationStatus)}.</div>`;
  });
}

void init();
