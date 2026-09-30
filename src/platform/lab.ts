/**
 * Test Lab: turns a plain-language scenario into a test case, a SYNTHETIC dataset and a
 * Playwright script, executes it (after a named human approves) and returns the complete
 * traceability chain. Parsing is deterministic (dictionary aliases + patterns).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pad } from '../shared/hash';
import { AqeConfig } from './config';
import { Store } from './store';
import { loadInputs, INPUT_FILES, Inputs } from './inputs';
import { resolveField } from './statements';
import { normalizeRequirements } from './agents/requirements';
import { CODE_ONLY_RULE_TEXT } from './agents/review';
import { extractRules } from './agents/business-rules';
import { assertProvenance, generateDataset } from './agents/test-data';
import { generateSuite } from './agents/automation';
import { executeSuite } from './agents/execution';
import { createDefects } from './agents/defects';
import { validateApprover, GovernanceError } from './pipeline';
import { AutomationScript, BusinessRule, Channel, Dataset, Defect, ExecutionResult, Requirement, TestCase } from './types';

export interface ChainLink {
  type: 'requirement' | 'rule' | 'test-case' | 'dataset' | 'script' | 'execution' | 'evidence' | 'defect';
  id: string;
  label: string;
  path?: string;
}

export interface LabRun {
  id: string;
  scenario: string;
  requestedBy: string;
  approvedBy: string;
  createdAt: string;
  status: 'passed' | 'failed' | 'blocked';
  rulesFrom: string;
  interpretation: { channel: Channel; ruleId: string; mutation: Record<string, unknown>; expectation: 'accepted' | 'rejected'; expectationSource: 'scenario' | 'data dictionary'; notes: string[] };
  testCase: TestCase;
  dataset: Dataset;
  script: AutomationScript | null;
  execution: ExecutionResult | null;
  defects: Defect[];
  blockedReason?: string;
  chain: ChainLink[];
}

const NEGATIVE = /\b(reject|rejected|rejects|fail|fails|error|invalid|not be (?:accepted|created|allowed|confirmed)|blocked|refused|disallowed)\b/;
const POSITIVE = /\b(accept|accepted|accepts|succeed|succeeds|success|confirmed|is created|be created|allowed|valid booking)\b/;

function rulesContext(store: Store, inputs: Inputs): { rules: BusinessRule[]; requirements: Requirement[]; from: string } {
  const latest = [...store.listCycles()].reverse().find((c) => store.readArtifact(c.id, 'rules/business-rules.json'));
  if (latest) {
    return {
      rules: store.readArtifact<BusinessRule[]>(latest.id, 'rules/business-rules.json')!,
      requirements: store.readArtifact<Requirement[]>(latest.id, 'requirements/baseline.json')!,
      from: `${latest.id} approved baseline`,
    };
  }
  const reqs = normalizeRequirements(inputs);
  const accepted = Object.entries(CODE_ONLY_RULE_TEXT).map(([ruleId, text]) => ({ ruleId, text }));
  return { rules: extractRules(reqs, inputs, accepted), requirements: reqs, from: 'input fixtures (no approved cycle yet)' };
}

/** Deterministically maps a scenario to a mutation of the valid base dataset. */
export function interpretScenario(text: string, inputs: Inputs): { mutation: Record<string, unknown>; field: string | null; channel: Channel; notes: string[]; stated: 'accepted' | 'rejected' | null } {
  const t = text.toLowerCase();
  const notes: string[] = [];
  const mutation: Record<string, unknown> = {};
  const dict = inputs.dictionary;
  let field: string | null = null;
  const stated = NEGATIVE.test(t) ? 'rejected' : POSITIVE.test(t) ? 'accepted' : null;

  let m: RegExpExecArray | null;
  if (/end date (?:is )?(?:before|earlier than) (?:the )?start date/.test(t)) {
    mutation.endDate = { $relative: 'startDate', days: -1 };
    field = 'endDate';
  } else if (/(?:same (?:day|date)|end date (?:equal to|equals|is the same as) (?:the )?start date)/.test(t)) {
    mutation.endDate = { $relative: 'startDate', days: 0 };
    field = 'endDate';
  } else if (/\b(unavailable|not available|fully booked|already booked)\b/.test(t)) {
    const u = dict.referenceData.knownUnavailable[0];
    Object.assign(mutation, { locationId: u.locationId, resourceType: u.resourceType, startDate: u.startDate, endDate: u.endDate });
    field = 'resourceType';
  } else if (/\bdeclin/.test(t)) {
    mutation['payment.paymentToken'] = { $token: 'decline' };
    field = 'payment.paymentToken';
  } else if ((m = /\b(?:without|missing|no|blank|empty|omit(?:ting)?)\s+(?:a |an |the )?([a-z ]+?)(?=\s+(?:should|must|is|will|and|gets?)\b|[.,]|$)/.exec(t))) {
    field = resolveField(m[1], dict);
    if (field) mutation[field] = null;
  } else {
    field = resolveField(t, dict);
    if (field) {
      const def = Object.values(dict.entities).flatMap((e) => Object.entries(e.fields)).find(([n]) => n === field!.split('.').pop())?.[1];
      let value: unknown;
      if (field === 'locationId') value = /\bloc-syn-\d{3}\b/.exec(t)?.[0].toUpperCase();
      else if (field === 'customer.email') value = /[^\s'"]+@[^\s'",]+/.exec(text)?.[0] ?? (/\b(invalid|malformed|bad)\b/.test(t) ? 'not-an-email' : undefined);
      else if (def?.enum) value = def.enum.find((v) => new RegExp(`\\b${v.toLowerCase().replace(/_/g, '[ _]')}\\b`).test(t));
      else if (def?.type === 'integer') {
        const n = /(-?\d+)/.exec(t.replace(/loc-syn-\d+/g, ''));
        if (n) value = Number(n[1]);
      }
      if (value !== undefined) mutation[field] = value;
      else notes.push(`Recognised field ${field} but no value; using the valid synthetic default.`);
    }
  }
  if (!field) notes.push('No field from the data dictionary was recognised; running the valid create path (BR-005).');
  const wantsUi = /\b(ui|screen|console|browser|form|page|associate enters)\b/.test(t);
  const uiSafe = Object.keys(mutation).every((k) => ['customerCount', 'startDate', 'endDate', 'customer.firstName', 'customer.lastName', 'customer.email', 'payment.paymentToken'].includes(k));
  let channel: Channel = wantsUi ? 'ui' : 'api';
  if (wantsUi && !uiSafe) {
    channel = 'api';
    notes.push('The console only offers valid select options for this field, so the scenario runs through the GraphQL API.');
  }
  return { mutation, field, channel, notes, stated };
}

export async function runLab(store: Store, config: AqeConfig, req: { scenario: string; requestedBy: string; approver: string }): Promise<LabRun> {
  const scenario = (req.scenario ?? '').trim();
  if (scenario.length < 8) throw new GovernanceError('Describe the scenario in a sentence (at least 8 characters).');
  const approver = validateApprover(req.approver);
  const inputs = loadInputs(Object.keys(INPUT_FILES));
  const { rules, requirements, from } = rulesContext(store, inputs);
  const id = `LAB-${pad(store.next('nextLab'), 4)}`;
  const dir = path.join(store.home, 'lab', id);
  const dictSha = inputs.documents.find((d) => d.key === 'data-dictionary')!.sha256;
  const parsed = interpretScenario(scenario, inputs);
  const tcId = `${id}-TC`;

  // Probe the data dictionary: which checks does this mutation violate?
  const probe = generateDataset({ id: tcId, mutation: parsed.mutation, violates: [] }, inputs.dictionary, dictSha);
  const violated = [...new Set(probe.validation.checks.filter((c) => c.result === 'fail').map((c) => c.field))];
  const expectation = parsed.stated ?? (violated.length ? 'rejected' : 'accepted');
  const ruleFor = (f: string) =>
    f === 'availability' ? rules.find((r) => r.check.type === 'availability') : f.includes('/') ? rules.find((r) => r.check.type === 'date-order') : rules.find((r) => r.check.fields.includes(f) && r.check.type !== 'availability');
  const rule = (violated.length ? ruleFor(violated[0]) : parsed.field ? rules.find((r) => r.check.fields.includes(parsed.field!) && r.check.type !== 'availability') : undefined) ?? rules.find((r) => r.check.type === 'generated-output')!;
  const reqIds = rule.sourceRequirements;
  const tc: TestCase = {
    id: tcId,
    title: `Test Lab: ${scenario.replace(/\s+/g, ' ').slice(0, 90)}`,
    type: expectation === 'rejected' ? 'negative' : 'positive',
    channel: parsed.channel,
    ruleIds: [rule.id],
    requirementIds: reqIds,
    objective: scenario,
    preconditions: ['Local demo service running with synthetic reference data'],
    steps: ['Load the linked synthetic dataset', parsed.channel === 'ui' ? 'Submit the create form in the console' : 'Call createReservation', `Assert the reservation is ${expectation}`],
    expected: expectation === 'rejected' ? { success: false, errorCode: rule.check.errorCode ?? 'VALIDATION_ERROR' } : { success: true, status: 'CONFIRMED', confirmationPattern: '^CNF-[A-Z0-9]{8}$' },
    mutation: parsed.mutation,
    violates: expectation === 'rejected' ? violated : [],
    flow: 'create',
    priority: 'P2',
  };
  const dataset = generateDataset(tc, inputs.dictionary, dictSha);
  const base: Omit<LabRun, 'status' | 'script' | 'execution' | 'defects' | 'chain'> = {
    id,
    scenario,
    requestedBy: req.requestedBy || approver,
    approvedBy: approver,
    createdAt: new Date().toISOString(),
    rulesFrom: from,
    interpretation: { channel: parsed.channel, ruleId: rule.id, mutation: parsed.mutation, expectation, expectationSource: parsed.stated ? 'scenario' : 'data dictionary', notes: parsed.notes },
    testCase: tc,
    dataset,
  };
  const chainHead: ChainLink[] = [
    ...reqIds.map((r) => ({ type: 'requirement' as const, id: r, label: requirements.find((x) => x.id === r)?.text ?? r })),
    { type: 'rule', id: rule.id, label: rule.text },
    { type: 'test-case', id: tc.id, label: `${tc.title} [${tc.type}/${tc.channel}]` },
    { type: 'dataset', id: dataset.id, label: `SYNTHETIC v${dataset.version} (${dataset.validation.status})`, path: `lab/${id}/automation/data/${dataset.id}.json` },
  ];
  store.audit({ actor: approver, actorType: 'human', action: 'approval', target: `${id}/execution`, details: { scenario, gate: 'lab-execution', decision: 'approved' } });

  let run: LabRun;
  if (dataset.validation.status !== 'valid' || (expectation === 'rejected' && !violated.length)) {
    const reason = dataset.validation.status !== 'valid'
      ? `Dataset ${dataset.id} fails data-dictionary validation (${dataset.validation.checks.filter((c) => c.result === 'fail').map((c) => `${c.field} ${c.rule}`).join(', ')}) but the scenario expects acceptance. Execution blocked.`
      : 'The scenario expects a rejection, but the synthetic data satisfies every data-dictionary rule. Rephrase the scenario with an invalid value.';
    run = { ...base, status: 'blocked', script: null, execution: null, defects: [], blockedReason: reason, chain: chainHead };
  } else {
    assertProvenance(dataset, config.approvedDatasetGenerators);
    const [script] = generateSuite(path.join(dir, 'automation'), store.home, [tc], [dataset], rules, `Test Lab ${id}`, 'AS-');
    const summary = await executeSuite({ automationDir: path.join(dir, 'automation'), runDir: path.join(dir, 'execution'), home: store.home, scripts: [script], runId: `RUN-${id}`, timeoutMs: config.executionTimeoutMs });
    const execution = summary.results[0];
    const defects = createDefects({ results: summary.results, testCases: [tc], rules, datasets: [dataset], home: store.home, idPrefix: `DEF-${id}-` });
    store.audit({ actor: 'Execution Agent', actorType: 'agent', action: 'execution', target: id, details: { approvedBy: approver, status: execution.status, build: summary.demoServiceBuild } });
    run = {
      ...base,
      status: execution.status === 'passed' ? 'passed' : execution.status === 'failed' ? 'failed' : 'blocked',
      ...(execution.status === 'not-run' ? { blockedReason: 'Playwright did not run the generated script; see the execution log.' } : {}),
      script,
      execution,
      defects,
      chain: [
        ...chainHead,
        { type: 'script', id: script.id, label: script.file, path: script.file },
        { type: 'execution', id: execution.id, label: `${execution.status.toUpperCase()} in ${execution.durationMs} ms against ${summary.demoServiceBuild}` },
        ...execution.evidence.map((e) => ({ type: 'evidence' as const, id: e.id, label: `${e.kind}: ${e.label}`, path: e.path })),
        ...defects.map((d) => ({ type: 'defect' as const, id: d.id, label: `[${d.severity}] ${d.title}` })),
      ],
    };
  }
  store.writeJson(path.join(store.stateDir, 'lab', `${id}.json`), run);
  store.writeJson(path.join(dir, 'lab-run.json'), run);
  store.audit({ actor: run.requestedBy, actorType: 'human', action: 'lab', target: id, details: { scenario, status: run.status, ruleId: rule.id } });
  return run;
}

export function listLab(store: Store): LabRun[] {
  const dir = path.join(store.stateDir, 'lab');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => store.readJson<LabRun>(path.join(dir, f))!);
}
