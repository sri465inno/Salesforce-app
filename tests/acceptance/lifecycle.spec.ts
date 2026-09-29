/**
 * Definition of done, steps 1-13, through the platform HTTP API: STORY-001 goes from inputs to a
 * rules-based recommendation with four human gates, real Playwright execution against the local
 * demo service, the seeded BR-002 defect, evidence, reports, exports and report-to-requirement
 * navigation. A second cycle against the fixed build then turns the recommendation to Go.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { startPlatform } from '../../src/platform/app';
import type { Cycle, Dataset, Defect, ExecutionSummary, ReviewFinding, TestCase, AutomationScript, AuditEntry } from '../../src/platform/types';
import type { Metrics } from '../../src/platform/agents/reporting';
import { HUMAN, config, json, tempStore, until } from './helpers';

interface TraceNodeRes { node: { id: string; type: string; up: string[]; down: string[]; path: string | null }; lineage: { id: string; type: string }[] }

test.describe.configure({ mode: 'serial' });

const store = tempStore('lifecycle');
let platform: Awaited<ReturnType<typeof startPlatform>>;
let cycleId = '';

const get = async <T>(p: string) => json<T>(await fetch(`${platform.url}${p}`));
const post = (p: string, body: unknown) => fetch(`${platform.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aqe-user': HUMAN }, body: JSON.stringify(body) });
const settle = () => until(() => get<Cycle>(`/api/cycles/${cycleId}`), (c) => c.status !== 'running');
const artifact = <T>(rel: string) => store.readArtifact<T>(cycleId, rel)!;

test.beforeAll(async () => {
  platform = await startPlatform(0, { store, config });
});
test.afterAll(async () => platform?.close());

test('1-2. loads STORY-001 inputs, reviews requirements and blocks until a human decides every finding', async () => {
  const created = await json<Cycle>(await post('/api/cycles', { mode: 'baseline', requestedBy: HUMAN }));
  cycleId = created.id;
  const c = await settle();
  expect(c.status).toBe('waiting-approval');
  expect(c.stages.find((s) => s.status === 'waiting-approval')?.gate).toBe('requirements-baseline');
  const manifest = artifact<{ key: string; sha256: string; recordedFrom: string }[]>('inputs/manifest.json');
  expect(manifest.map((m) => m.key)).toEqual(expect.arrayContaining(['initiative', 'epic', 'story', 'business-rules', 'graphql-contract', 'data-dictionary', 'source-code-references']));
  expect(manifest.every((m) => m.sha256.length === 64 && m.recordedFrom)).toBe(true);
  const draft = artifact<{ sourceId: string; text: string }[]>('requirements/draft.json');
  expect(draft.some((r) => r.sourceId === 'STORY-001')).toBe(true);

  const findings = artifact<ReviewFinding[]>('review/findings.json');
  expect(findings.map((f) => f.type)).toEqual(expect.arrayContaining(['duplicate', 'conflict']));

  // Agents cannot approve; a named human must decide every finding.
  const byAgent = await post(`/api/cycles/${cycleId}/approvals`, { gate: 'requirements-baseline', approver: 'Review Agent', decision: 'approved' });
  expect(byAgent.status).toBe(409);
  expect(((await byAgent.json()) as { error: string }).error).toMatch(/cannot approve/);
  const undecided = await post(`/api/cycles/${cycleId}/approvals`, { gate: 'requirements-baseline', approver: HUMAN, decision: 'approved' });
  expect(undecided.status).toBe(409);
  expect((await get<Cycle>(`/api/cycles/${cycleId}`)).status).toBe('waiting-approval');

  const findingDecisions = findings.map((f) => ({ findingId: f.id, decision: 'accept', comment: 'Agree with the recommendation' }));
  await json(await post(`/api/cycles/${cycleId}/approvals`, { gate: 'requirements-baseline', approver: HUMAN, decision: 'approved', comments: 'Baseline approved', findingDecisions }));
});

test('3-4. extracts business rules linked to requirements, designs every test type with a coverage matrix', async () => {
  const c = await settle();
  expect(c.stages.find((s) => s.status === 'waiting-approval')?.gate).toBe('test-design');
  const rules = artifact<{ id: string; sourceRequirements: string[] }[]>('rules/business-rules.json');
  expect(rules.map((r) => r.id)).toEqual(expect.arrayContaining(['BR-001', 'BR-002', 'BR-003', 'BR-004', 'BR-005', 'BR-006', 'BR-007']));
  expect(rules.every((r) => r.sourceRequirements.length > 0)).toBe(true);
  const tcs = artifact<TestCase[]>('tests/test-cases.json');
  expect(new Set(tcs.map((t) => t.type))).toEqual(new Set(['smoke', 'positive', 'negative', 'boundary', 'e2e']));
  expect(new Set(tcs.map((t) => t.channel))).toEqual(new Set(['ui', 'api']));
  expect(tcs.some((t) => t.mutation.customerCount === 0 && t.ruleIds.includes('BR-002'))).toBe(true);
  const coverage = artifact<{ requirementId: string; testCaseIds: string[] }[]>('tests/coverage-matrix.json');
  expect(coverage.length).toBeGreaterThan(0);
  await json(await post(`/api/cycles/${cycleId}/approvals`, { gate: 'test-design', approver: HUMAN, decision: 'approved', comments: 'Coverage reviewed' }));
});

test('5-7. generates validated SYNTHETIC data and linked Playwright automation; execution waits for approval', async () => {
  const c = await settle();
  expect(c.stages.find((s) => s.status === 'waiting-approval')?.gate).toBe('execution');
  const tcs = artifact<TestCase[]>('tests/test-cases.json');
  const datasets = artifact<Dataset[]>('data/datasets.json');
  expect(datasets).toHaveLength(tcs.length);
  expect(datasets.every((d) => d.classification === 'SYNTHETIC' && d.validation.status === 'valid' && d.provenance.generator === 'aqe-test-data-agent@1.0.0')).toBe(true);
  const scripts = artifact<AutomationScript[]>('automation/scripts.json');
  expect(scripts).toHaveLength(tcs.length);
  for (const s of scripts) {
    const src = fs.readFileSync(path.join(store.home, s.file), 'utf8');
    expect(src).toContain(`${s.testCaseId} [`);
    expect(src).toContain(s.datasetId);
    expect(src).toContain(s.ruleIds[0]);
  }
  expect(scripts.filter((s) => s.channel === 'ui').length).toBeGreaterThan(0);
  expect(scripts.filter((s) => s.channel === 'api').length).toBeGreaterThan(0);
  expect(store.readArtifact(cycleId, 'execution/summary.json')).toBeNull();
  await json(await post(`/api/cycles/${cycleId}/approvals`, { gate: 'execution', approver: HUMAN, decision: 'approved', comments: 'Run it' }));
});

test('8-11. executes against the demo service, detects customerCount = 0, captures evidence and creates a traceable defect', async () => {
  const c = await settle();
  expect(c.stages.find((s) => s.status === 'waiting-approval')?.gate).toBe('release');
  const summary = artifact<ExecutionSummary>('execution/summary.json');
  expect(summary.demoServiceBuild).toContain('seeded defect BR-002');
  expect(summary.totals.total).toBe(artifact<TestCase[]>('tests/test-cases.json').length);
  const failed = summary.results.filter((r) => r.status === 'failed');
  expect(failed.length).toBeGreaterThan(0);
  const tcs = artifact<TestCase[]>('tests/test-cases.json');
  for (const r of failed) expect(tcs.find((t) => t.id === r.testCaseId)?.ruleIds).toContain('BR-002');
  const kinds = new Set(failed.flatMap((r) => r.evidence.map((e) => e.kind)));
  for (const k of ['screenshot', 'trace', 'request-response', 'service-log']) expect(kinds).toContain(k);
  for (const e of failed.flatMap((r) => r.evidence)) expect(fs.existsSync(path.join(store.home, e.path))).toBe(true);

  const defects = artifact<Defect[]>('defects/defects.json');
  expect(defects).toHaveLength(1);
  const d = defects[0];
  expect(d).toMatchObject({ ruleId: 'BR-002', severity: 'high', blocksRelease: true, createdFrom: 'execution-failure' });
  expect(d.actual).toMatch(/success=true/);
  for (const k of ['expected', 'impact', 'suspectedCause', 'suggestedRemediation'] as const) expect(d[k].length).toBeGreaterThan(20);
  expect(d.executionIds.sort()).toEqual(failed.map((r) => r.id).sort());
  expect(d.codeReference?.file).toBe('src/demo-service/reservation-validator.ts');
});

test('12-13. QE lead report with rules-based No-go, and navigation from report back to the requirement', async () => {
  const m = artifact<Metrics>('reports/metrics.json');
  expect(m.recommendation.decision).toBe('No-go');
  expect(m.recommendation.policy.find((p) => p.id === 'RP-4')?.passed).toBe(false);
  const md = fs.readFileSync(path.join(store.cycleDir(cycleId), 'reports', 'qe-lead-report.md'), 'utf8');
  for (const h of ['Executive summary', 'Inputs and scope', 'Requirements and business rules', 'test assets', 'Execution results', 'Coverage', 'Defects', 'Risks and gaps', 'Privacy and security validation', 'Approval status', 'go/no-go recommendation', 'Human sign-off']) expect(md.toLowerCase()).toContain(h.toLowerCase());
  for (const f of ['cycle-report.md', 'coverage-report.md', 'execution-summary.md', 'defect-report.md', 'release-readiness.md', 'executive-dashboard.html', 'qe-lead-report.html']) expect(fs.existsSync(path.join(store.cycleDir(cycleId), 'reports', f))).toBe(true);

  // Report -> defect -> evidence -> execution -> script -> dataset -> test case -> rule -> requirement
  const report = await get<TraceNodeRes>(`/api/cycles/${cycleId}/trace/RPT-${cycleId}-QE-LEAD`);
  const defectId = report.node.up.find((u) => u.startsWith('DEF-'))!;
  expect(defectId).toBeTruthy();
  const path_: string[] = ['report'];
  let node = await get<TraceNodeRes>(`/api/cycles/${cycleId}/trace/${defectId}`);
  path_.push(node.node.type);
  const order = ['evidence', 'execution', 'script', 'dataset', 'test-case', 'rule', 'requirement'];
  for (const type of order) {
    const nodes = await Promise.all(node.node.up.map((u) => get<TraceNodeRes>(`/api/cycles/${cycleId}/trace/${encodeURIComponent(u)}`)));
    const next = nodes.find((n) => n.node.type === type) ?? (type === 'evidence' ? undefined : nodes.find((n) => n.node.type === type));
    if (type === 'evidence' && !next) {
      // defects link to executions and evidence; evidence then links to its execution
      const ev = node.node.down.concat(node.node.up).find((x) => x.startsWith('EV-'))!;
      node = await get<TraceNodeRes>(`/api/cycles/${cycleId}/trace/${ev}`);
    } else {
      expect(next, `no ${type} upstream of ${node.node.id}`).toBeTruthy();
      node = next!;
    }
    path_.push(node.node.type);
  }
  expect(path_).toEqual(['report', 'defect', ...order]);
  expect(node.node.id).toMatch(/^REQ-/);

  const exp = await get<{ rows: { defectIds: string; requirementId: string }[]; classification: string }>(`/api/cycles/${cycleId}/export.json`);
  expect(exp.classification).toBe('SYNTHETIC');
  expect(exp.rows.some((r) => r.defectIds.includes(defectId))).toBe(true);
  const xlsx = await fetch(`${platform.url}/api/cycles/${cycleId}/export.xlsx`);
  expect(xlsx.headers.get('content-type')).toContain('spreadsheetml');
  expect(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');

  const rejectNoComment = await post(`/api/cycles/${cycleId}/approvals`, { gate: 'release', approver: HUMAN, decision: 'rejected' });
  expect(rejectNoComment.status).toBe(409);
  const signed = await json<Cycle>(await post(`/api/cycles/${cycleId}/approvals`, { gate: 'release', approver: HUMAN, decision: 'approved', comments: 'Agree with No-go until DEF-001 is fixed' }));
  expect(signed.status).toBe('completed');
  expect(signed.baselineId).toMatch(/^BL-/);
  const audit = await get<AuditEntry[]>('/api/audit');
  const approvals = audit.filter((a) => a.action === 'approval' && a.target.startsWith(cycleId));
  expect(approvals.map((a) => (a.details as { gate: string }).gate)).toEqual(['requirements-baseline', 'test-design', 'execution', 'release']);
  expect(approvals.every((a) => a.actor === HUMAN && a.at)).toBe(true);
  expect(audit.some((a) => a.action === 'execution' && a.target === cycleId)).toBe(true);
});

test('re-test against the fixed build passes every test and the recommendation becomes Go', async () => {
  const created = await json<Cycle>(await post('/api/cycles', { mode: 'baseline', requestedBy: HUMAN, fixedDefects: ['BR-002'] }));
  cycleId = created.id;
  expect(created.previousBaselineId).toMatch(/^BL-/);
  for (const gate of ['requirements-baseline', 'test-design', 'execution']) {
    await settle();
    const findingDecisions = gate === 'requirements-baseline' ? artifact<ReviewFinding[]>('review/findings.json').map((f) => ({ findingId: f.id, decision: 'accept' })) : undefined;
    await json(await post(`/api/cycles/${cycleId}/approvals`, { gate, approver: HUMAN, decision: 'approved', comments: 'ok', findingDecisions }));
  }
  await settle();
  const m = artifact<Metrics>('reports/metrics.json');
  expect(m.execution.failed).toBe(0);
  expect(m.defects.total).toBe(0);
  expect(m.recommendation.decision).toBe('Go');
});
