/**
 * Test Data Agent: one deterministic SYNTHETIC dataset per test case, validated against the
 * data dictionary. Negative cases must violate exactly the checks they declare; anything else
 * makes the dataset invalid. Production data is never read.
 */
import { luhn } from '../../shared/mask';
import { pick, seededRandom, sha256 } from '../../shared/hash';
import { DataDictionary, allFields } from '../inputs';
import { Dataset, DatasetCheck, TestCase } from '../types';

export const AGENT = 'Test Data Agent';
export const GENERATOR = 'aqe-test-data-agent@1.0.0';

export const SYNTHETIC_FIRST_NAMES = ['Avery', 'Jordan', 'Riley', 'Quinn', 'Morgan', 'Casey', 'Rowan', 'Sage'];
export const SYNTHETIC_LAST_NAMES = ['Synthwell', 'Testwood', 'Mockridge', 'Fixtureson', 'Sampleton', 'Datafield', 'Placeholder', 'Stubbins'];

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function baseValues(seed: string, dictionary: DataDictionary): Dataset['values'] {
  const rand = seededRandom(seed);
  const first = pick(rand, SYNTHETIC_FIRST_NAMES);
  const last = pick(rand, SYNTHETIC_LAST_NAMES);
  const active = dictionary.referenceData.locations.filter((l) => l.active);
  const startDate = addDays('2027-01-04', Math.floor(rand() * 50));
  const n = Math.floor(rand() * 900) + 100;
  return {
    locationId: pick(rand, active).locationId,
    startDate,
    endDate: addDays(startDate, 1 + Math.floor(rand() * 4)),
    customerCount: 1 + Math.floor(rand() * 4),
    resourceType: 'STANDARD_ROOM',
    customer: { firstName: first, lastName: last, email: `${first}.${last}.${n}@example.test`.toLowerCase() },
    payment: { paymentMethod: 'CARD_TOKEN', paymentToken: `tok_synthetic_${sha256(`${seed}:token`).slice(0, 12)}` },
  };
}

function setPath(values: Dataset['values'], key: string, value: unknown, seed: string, dictionary: DataDictionary) {
  let v = value;
  if (v && typeof v === 'object' && '$relative' in v) {
    const r = v as { $relative: 'startDate'; days: number };
    v = addDays(values[r.$relative]!, r.days);
  } else if (v && typeof v === 'object' && '$token' in v) {
    v = `${dictionary.referenceData.gatewayTokens.declinedPrefix}${sha256(`${seed}:decline`).slice(0, 5)}`;
  }
  const [head, tail] = key.split('.');
  if (tail) (values[head as 'customer' | 'payment'] as Record<string, unknown>)[tail] = v;
  else (values as unknown as Record<string, unknown>)[head] = v;
}

export function generateDataset(tc: Pick<TestCase, 'id' | 'mutation' | 'violates'>, dictionary: DataDictionary, dictionarySha256: string, idPrefix = 'DS-'): Dataset {
  const seed = `${tc.id}:${dictionary.version}`;
  const values = baseValues(seed, dictionary);
  for (const [k, v] of Object.entries(tc.mutation)) setPath(values, k, v, seed, dictionary);
  const dataset: Dataset = {
    id: `${idPrefix}${tc.id}`,
    testCaseId: tc.id,
    classification: 'SYNTHETIC',
    version: 1,
    provenance: { generator: GENERATOR, seed, dictionaryVersion: dictionary.version, dictionarySha256, generatedAt: new Date().toISOString() },
    values,
    intentionalViolations: tc.violates,
    validation: { status: 'valid', checks: [], privacy: [] },
  };
  dataset.validation = validateDataset(dataset, dictionary);
  return dataset;
}

const get = (values: Dataset['values'], path: string): unknown => {
  const [head, tail] = path.split('.');
  const top = (values as unknown as Record<string, unknown>)[head];
  return tail ? (top as Record<string, unknown> | undefined)?.[tail] : top;
};

export function validateDataset(ds: Dataset, dictionary: DataDictionary): Dataset['validation'] {
  const raw: Omit<DatasetCheck, 'result'>[] = [];
  const failed: boolean[] = [];
  const add = (field: string, rule: string, ok: boolean, detail: string) => {
    raw.push({ field, rule, detail });
    failed.push(!ok);
  };
  for (const f of allFields(dictionary).filter((x) => x.def.source === 'user')) {
    const v = get(ds.values, f.path);
    const blank = v === null || v === undefined || v === '';
    if (f.def.required) add(f.path, 'required', !blank, blank ? 'missing' : 'present');
    if (blank) continue;
    if (f.def.type === 'integer') add(f.path, 'type:integer', Number.isInteger(v), String(v));
    if (f.def.type === 'date') add(f.path, 'type:date', /^\d{4}-\d{2}-\d{2}$/.test(String(v)), String(v));
    if (f.def.pattern) add(f.path, 'pattern', new RegExp(f.def.pattern).test(String(v)), f.def.pattern);
    if (f.def.enum) add(f.path, 'enum', f.def.enum.includes(String(v)), f.def.enum.join('|'));
    if (f.def.min !== undefined) add(f.path, `min:${f.def.min}`, Number(v) >= f.def.min, String(v));
    if (f.def.max !== undefined) add(f.path, `max:${f.def.max}`, Number(v) <= f.def.max, String(v));
    if (f.def.maxLength !== undefined) add(f.path, `maxLength:${f.def.maxLength}`, String(v).length <= f.def.maxLength, String(String(v).length));
    if (f.def.reference === 'locations') {
      const loc = dictionary.referenceData.locations.find((l) => l.locationId === v);
      add(f.path, 'reference:active-location', !!loc?.active, loc ? (loc.active ? 'active' : 'inactive') : 'unknown');
    }
    if (f.def.approvedValues) add(f.path, 'approved-value', f.def.approvedValues.includes(String(v)), f.def.approvedValues.join('|'));
  }
  const { startDate, endDate, locationId, resourceType } = ds.values;
  if (startDate && endDate) add('startDate/endDate', 'startDate < endDate', startDate < endDate, `${startDate} .. ${endDate}`);
  const unavailable = dictionary.referenceData.knownUnavailable.find((u) => u.locationId === locationId && u.resourceType === resourceType && startDate! < u.endDate && u.startDate < endDate!);
  add('availability', 'resource available', !unavailable, unavailable ? unavailable.note : 'no known conflict');
  const token = ds.values.payment.paymentToken ?? '';
  const gw = dictionary.referenceData.gatewayTokens;
  if (token) add('payment.paymentToken', 'gateway-authorizable', !token.startsWith(gw.declinedPrefix) && !token.startsWith(gw.pendingPrefix), token.startsWith(gw.declinedPrefix) ? 'declined token' : 'authorizable token');

  const checks: DatasetCheck[] = raw.map((c, i) => ({
    ...c,
    result: failed[i] ? (ds.intentionalViolations.includes(c.field) ? 'intentional-violation' : 'fail') : 'pass',
  }));
  for (const field of ds.intentionalViolations) {
    if (!checks.some((c) => c.field === field && c.result === 'intentional-violation')) {
      checks.push({ field, rule: 'intended violation present', result: 'fail', detail: 'the test case expects this check to be violated but it is not' });
    }
  }
  const privacy = privacyChecks(ds);
  const status = checks.some((c) => c.result === 'fail') || privacy.some((c) => c.result !== 'pass') ? 'invalid' : 'valid';
  return { status, checks, privacy };
}

export function privacyChecks(ds: Dataset): DatasetCheck[] {
  const text = JSON.stringify(ds.values);
  const email = ds.values.customer.email ?? '';
  const token = ds.values.payment.paymentToken ?? '';
  const digitRuns = text.match(/\d[\d -]{11,}\d/g) ?? [];
  const pc = (rule: string, ok: boolean, detail: string): DatasetCheck => ({ field: 'dataset', rule, result: ok ? 'pass' : 'fail', detail });
  return [
    pc('classification is SYNTHETIC', ds.classification === 'SYNTHETIC', ds.classification),
    pc('provenance generator recognised', ds.provenance.generator === GENERATOR && !!ds.provenance.seed, ds.provenance.generator),
    pc('email uses reserved synthetic domain', !email.includes('@') || email.endsWith('@example.test'), email ? 'example.test' : 'no email'),
    pc('payment token is a synthetic placeholder', !token || token.startsWith('tok_synthetic_'), token ? 'tok_synthetic_*' : 'no token'),
    pc('no payment-card numbers', !digitRuns.some((d) => luhn(d.replace(/\D/g, ''))), `${digitRuns.length} long digit runs scanned`),
    pc('names drawn from synthetic name lists', (!ds.values.customer.firstName || SYNTHETIC_FIRST_NAMES.includes(ds.values.customer.firstName)) && (!ds.values.customer.lastName || SYNTHETIC_LAST_NAMES.includes(ds.values.customer.lastName)), 'synthetic lists'),
  ];
}

/** Rejects datasets with unknown or unapproved provenance before they reach automation. */
export function assertProvenance(ds: Partial<Dataset>, approvedGenerators: string[]): void {
  const p = ds.provenance;
  if (ds.classification !== 'SYNTHETIC') throw new Error(`Dataset ${ds.id ?? '(unnamed)'} rejected: not classified SYNTHETIC`);
  if (!p || !p.generator || !p.seed || !approvedGenerators.includes(p.generator)) {
    throw new Error(`Dataset ${ds.id ?? '(unnamed)'} rejected: unknown provenance (${p?.generator ?? 'none'})`);
  }
}
