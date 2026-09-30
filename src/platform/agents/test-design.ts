/**
 * Test Design Agent: generates positive, negative, boundary, smoke and end-to-end cases per
 * business rule and a requirement coverage matrix. Selection honours the run's testing types,
 * channels and skills; incremental runs select cases linked to changed requirements plus smoke.
 */
import { pad } from '../../shared/hash';
import { Inputs } from '../inputs';
import { BusinessRule, Channel, CycleConfig, Requirement, TestCase, TestType } from '../types';

export const AGENT = 'Test Design Agent';

type Draft = Omit<TestCase, 'id' | 'requirementIds' | 'ruleIds' | 'preconditions' | 'priority'> & { priority?: TestCase['priority'] };

const rel = (days: number) => ({ $relative: 'startDate', days });

function draftsFor(rule: BusinessRule, inputs: Inputs): Draft[] {
  const c = rule.check;
  const code = c.errorCode ?? undefined;
  const f = c.fields[0];
  const reject = (errorCode = code) => ({ success: false, errorCode });
  const ok = { success: true, confirmationPattern: '^CNF-[A-Z0-9]{8}$', status: 'CONFIRMED' };
  const api = (type: TestType, title: string, mutation: Record<string, unknown>, expected: TestCase['expected'], violates: string[], objective: string): Draft => ({
    title, type, channel: 'api', mutation, expected, violates, objective, flow: 'create',
    steps: ['Load the linked synthetic dataset', 'Call the createReservation GraphQL mutation', `Assert ${expected.success ? 'success, CONFIRMED status and confirmation-number format' : `success=false and error ${expected.errorCode}`}`],
  });
  switch (c.type) {
    case 'generated-output':
      return [
        { ...api('smoke', 'Smoke: createReservation with valid synthetic data returns a confirmation number', {}, ok, [], 'The core create path works and issues a confirmation number.'), priority: 'P1' },
        {
          title: 'Service associate creates a reservation in the console and receives a confirmation number', type: 'positive', channel: 'ui', mutation: {}, expected: ok, violates: [], flow: 'create', priority: 'P1',
          objective: 'The Lightning-style create form shows the generated confirmation number.',
          steps: ['Open the reservation console', 'Fill the create form with the synthetic dataset', 'Submit', 'Assert the confirmation number and CONFIRMED status are shown'],
        },
        {
          title: 'End to end: create, search by confirmation number and cancel the reservation', type: 'e2e', channel: 'ui', mutation: {}, expected: { success: true, status: 'CANCELLED', confirmationPattern: ok.confirmationPattern }, violates: [], flow: 'create-search-cancel', priority: 'P1',
          objective: 'A confirmed reservation can be found and cancelled by its confirmation number.',
          steps: ['Create a reservation in the console', 'Search by the confirmation number', 'Cancel it with a reason', 'Assert status CANCELLED in the search results'],
        },
      ];
    case 'date-order':
      return [
        api('negative', `${f} after ${c.fields[1]} is rejected`, { [c.fields[1]]: rel(-1) }, reject(), ['startDate/endDate'], 'End date before start date must be rejected.'),
        api('boundary', `${f} equal to ${c.fields[1]} is rejected`, { [c.fields[1]]: rel(0) }, reject(), ['startDate/endDate'], 'Same-day start and end is not "earlier than" and must be rejected.'),
        api('boundary', `${c.fields[1]} one day after ${f} is accepted`, { [c.fields[1]]: rel(1) }, ok, [], 'The smallest valid date range is accepted.'),
      ];
    case 'min-exclusive': {
      const t = c.parameters.threshold as number;
      const max = c.parameters.max as number | undefined;
      const out: Draft[] = [
        { ...api('boundary', `${f} = ${t} is rejected`, { [f]: t }, reject(), [f], `${f} must be greater than ${t}; the boundary value ${t} must be rejected.`), priority: 'P1' },
        {
          title: `${f} = ${t} is rejected in the console`, type: 'boundary', channel: 'ui', mutation: { [f]: t }, expected: reject(), violates: [f], flow: 'create', priority: 'P1',
          objective: `The console must not confirm a reservation with ${f} = ${t}.`,
          steps: ['Open the reservation console', `Fill the create form with ${f} = ${t}`, 'Submit', `Assert the error ${code} is shown and no confirmation number is issued`],
        },
        api('negative', `${f} = ${t - 1} is rejected`, { [f]: t - 1 }, reject(), [f], `Negative ${f} must be rejected.`),
        api('boundary', `${f} = ${t + 1} is accepted`, { [f]: t + 1 }, ok, [], `The smallest valid ${f} is accepted.`),
      ];
      if (max !== undefined) {
        out.push(api('boundary', `${f} = ${max} (dictionary maximum) is accepted`, { [f]: max }, ok, [], `The largest valid ${f} is accepted.`));
        out.push(api('boundary', `${f} = ${max + 1} is rejected`, { [f]: max + 1 }, reject(), [f], `${f} above the dictionary maximum must be rejected.`));
      }
      return out;
    }
    case 'reference': {
      const inactive = inputs.dictionary.referenceData.locations.find((l) => !l.active);
      return [
        api('negative', `Unknown ${f} is rejected`, { [f]: 'LOC-SYN-999' }, reject(), [f], `A ${f} that does not exist must be rejected.`),
        ...(inactive ? [api('negative', `Inactive ${f} ${inactive.locationId} is rejected`, { [f]: inactive.locationId }, reject(), [f], `An inactive ${f} must be rejected.`)] : []),
      ];
    }
    case 'approved-value': {
      const approved = c.parameters.approvedValues as string[];
      const all = inputs.dictionary.entities.Payment.fields.paymentMethod.enum ?? [];
      const bad = all.find((v) => !approved.includes(v));
      return [
        ...(bad ? [api('negative', `Unapproved ${f} ${bad} is rejected`, { [f]: bad }, reject(), [f], `Only approved payment methods are accepted.`)] : []),
        ...(approved[1] ? [api('positive', `Approved ${f} ${approved[1]} is accepted`, { [f]: approved[1] }, ok, [], 'Every approved payment method is accepted.')] : []),
      ];
    }
    case 'required-fields':
      return c.fields.map((field) => api('negative', `Missing ${field} is rejected`, { [field]: null }, reject(), [field], `${field} is required.`));
    case 'availability': {
      const u = inputs.dictionary.referenceData.knownUnavailable[0];
      if (!u) return [];
      return [api('negative', `Unavailable ${u.resourceType} at ${u.locationId} for booked dates is rejected`, { locationId: u.locationId, resourceType: u.resourceType, startDate: u.startDate, endDate: u.endDate }, reject(), ['availability'], 'A fully booked resource must not be reserved.')];
    }
    case 'format':
      return [api('negative', `Malformed ${f} is rejected`, { [f]: 'not-an-email' }, reject(), [f], `${f} must be syntactically valid.`)];
    case 'authorization':
      return [api('negative', 'Declined synthetic payment token is rejected', { 'payment.paymentToken': { $token: 'decline' } }, reject(), ['payment.paymentToken'], 'A payment the gateway declines must not produce a reservation.')];
  }
}

export interface TestDesign {
  testCases: TestCase[];
  excluded: { title: string; ruleId: string; reason: string }[];
  coverage: CoverageRow[];
}

export interface CoverageRow {
  requirementId: string;
  sourceId: string;
  text: string;
  status: string;
  ruleIds: string[];
  testCaseIds: string[];
  byType: Record<TestType, number>;
  coverage: 'covered' | 'not covered' | 'merged' | 'non-functional (privacy controls)';
}

export function designTests(rules: BusinessRule[], requirements: Requirement[], inputs: Inputs, config: CycleConfig, changedRequirementIds: string[] | null): TestDesign {
  const testCases: TestCase[] = [];
  const excluded: TestDesign['excluded'] = [];
  const channelAllowed = (ch: Channel) => config.channels.includes(ch) && config.skills.includes(ch === 'ui' ? 'playwright-ui' : 'graphql-api');
  for (const rule of rules) {
    for (const d of draftsFor(rule, inputs)) {
      const reason = !config.testingTypes.includes(d.type)
        ? `testing type ${d.type} not selected`
        : !channelAllowed(d.channel)
          ? `${d.channel.toUpperCase()} channel or skill not selected`
          : changedRequirementIds && d.type !== 'smoke' && !rule.sourceRequirements.some((r) => changedRequirementIds.includes(r))
            ? 'incremental run: linked requirements unchanged since the last baseline'
            : null;
      if (reason) {
        excluded.push({ title: d.title, ruleId: rule.id, reason });
        continue;
      }
      testCases.push({
        ...d,
        id: `TC-${pad(testCases.length + 1)}`,
        ruleIds: [rule.id],
        requirementIds: rule.sourceRequirements,
        preconditions: ['Local demo reservation service is running', `Synthetic dataset DS-TC-${pad(testCases.length + 1)} is valid`],
        priority: d.priority ?? (d.type === 'boundary' || d.type === 'negative' ? 'P2' : 'P1'),
      });
    }
  }
  return { testCases, excluded, coverage: coverageMatrix(requirements, rules, testCases) };
}

export function coverageMatrix(requirements: Requirement[], rules: BusinessRule[], testCases: TestCase[]): CoverageRow[] {
  return requirements.map((r) => {
    const ruleIds = rules.filter((b) => b.sourceRequirements.includes(r.id)).map((b) => b.id);
    const tcs = testCases.filter((t) => t.requirementIds.includes(r.id));
    const byType = { smoke: 0, positive: 0, negative: 0, boundary: 0, e2e: 0 } as Record<TestType, number>;
    for (const t of tcs) byType[t.type] += 1;
    const coverage: CoverageRow['coverage'] =
      r.status === 'merged' ? 'merged' : tcs.length ? 'covered' : /synthetic/i.test(r.text) ? 'non-functional (privacy controls)' : 'not covered';
    return { requirementId: r.id, sourceId: r.sourceId, text: r.text, status: r.status, ruleIds, testCaseIds: tcs.map((t) => t.id), byType, coverage };
  });
}
