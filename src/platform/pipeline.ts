/**
 * Cycle orchestration: runs the nine agents in order, stops at the four mandatory human
 * gates, persists after every stage (so an interrupted cycle resumes after restart) and
 * writes every approval, execution and state change to the audit log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pad } from '../shared/hash';
import { AqeConfig } from './config';
import { Store } from './store';
import { loadInputs, Inputs } from './inputs';
import { loadBundle, traceWorkbook } from './bundle';
import * as requirementsAgent from './agents/requirements';
import * as reviewAgent from './agents/review';
import * as rulesAgent from './agents/business-rules';
import * as designAgent from './agents/test-design';
import * as dataAgent from './agents/test-data';
import * as automationAgent from './agents/automation';
import * as executionAgent from './agents/execution';
import * as defectAgent from './agents/defects';
import * as reportingAgent from './agents/reporting';
import { Approval, ArtifactRef, BusinessRule, Cycle, CycleConfig, Dataset, Decision, FindingDecision, GateId, Requirement, ReviewFinding, StageId, StageState, TestCase } from './types';

interface StageDef {
  id: StageId;
  name: string;
  agent: string | null;
  gate: GateId | null;
  inputs: string[];
}

export const STAGES: StageDef[] = [
  { id: 'intake', name: 'Load inputs', agent: 'Intake', gate: null, inputs: ['fixtures/inputs/*.json', 'contracts/reservation.graphql'] },
  { id: 'requirements', name: 'Normalize requirements', agent: requirementsAgent.AGENT, gate: null, inputs: ['inputs/manifest.json'] },
  { id: 'review', name: 'Review requirements', agent: reviewAgent.AGENT, gate: null, inputs: ['requirements/draft.json', 'source-code-references'] },
  { id: 'gate-requirements-baseline', name: 'Gate 1: requirements baseline', agent: null, gate: 'requirements-baseline', inputs: ['requirements/draft.json', 'review/findings.json'] },
  { id: 'business-rules', name: 'Extract business rules', agent: rulesAgent.AGENT, gate: null, inputs: ['requirements/baseline.json', 'data-dictionary'] },
  { id: 'test-design', name: 'Design tests and coverage', agent: designAgent.AGENT, gate: null, inputs: ['rules/business-rules.json'] },
  { id: 'gate-test-design', name: 'Gate 2: test cases and coverage', agent: null, gate: 'test-design', inputs: ['tests/test-cases.json', 'tests/coverage-matrix.json'] },
  { id: 'test-data', name: 'Generate synthetic test data', agent: dataAgent.AGENT, gate: null, inputs: ['tests/test-cases.json', 'data-dictionary'] },
  { id: 'automation', name: 'Generate Playwright UI and GraphQL tests', agent: automationAgent.AGENT, gate: null, inputs: ['tests/test-cases.json', 'data/datasets.json', 'contracts/reservation.graphql'] },
  { id: 'gate-execution', name: 'Gate 3: automation execution', agent: null, gate: 'execution', inputs: ['automation/scripts.json'] },
  { id: 'execution', name: 'Execute against local demo service', agent: executionAgent.AGENT, gate: null, inputs: ['automation/'] },
  { id: 'defects', name: 'Create defects from failures', agent: defectAgent.AGENT, gate: null, inputs: ['execution/summary.json'] },
  { id: 'reporting', name: 'Generate reports and recommendation', agent: reportingAgent.AGENT, gate: null, inputs: ['all cycle artifacts'] },
  { id: 'gate-release', name: 'Gate 4: final baseline and release', agent: null, gate: 'release', inputs: ['reports/qe-lead-report.md', 'reports/release-readiness.json'] },
];

export const AGENT_NAMES = STAGES.map((s) => s.agent).filter((a): a is string => !!a);

export interface ApprovalRequest {
  approver: string;
  decision: Decision;
  comments?: string;
  findingDecisions?: FindingDecision[];
}

export class GovernanceError extends Error {}

export function validateApprover(name: string): string {
  const approver = (name ?? '').trim();
  if (approver.length < 3) throw new GovernanceError('Approver name is required (at least 3 characters).');
  if (/\b(agent|bot|system|automation|ai|llm)\b/i.test(approver) || AGENT_NAMES.some((a) => a.toLowerCase() === approver.toLowerCase())) {
    throw new GovernanceError('Agents may recommend but cannot approve: approvals must be recorded by a named human.');
  }
  return approver;
}

export class Pipeline {
  private readonly active = new Map<string, Promise<Cycle>>();

  constructor(
    readonly store: Store,
    readonly config: AqeConfig,
  ) {}

  createCycle(config: CycleConfig): Cycle {
    loadInputs(config.inputs);
    if (!config.testingTypes.length) throw new GovernanceError('Select at least one testing type.');
    if (!config.channels.length) throw new GovernanceError('Select at least one channel (UI or API).');
    const previous = [...this.store.listCycles()].reverse().find((c) => c.baselineId);
    if (config.mode === 'incremental' && !previous) throw new GovernanceError('Incremental runs need an approved final baseline from an earlier cycle.');
    const now = new Date().toISOString();
    const cycle: Cycle = {
      id: `CYC-${pad(this.store.next('nextCycle'), 4)}`,
      config,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      stages: STAGES.map((s) => ({ id: s.id, name: s.name, agent: s.agent, gate: s.gate, status: 'pending', startedAt: null, finishedAt: null, inputs: s.inputs, outputs: [], summary: null, error: null })),
      approvals: [],
      baselineId: null,
      previousBaselineId: previous?.baselineId ?? null,
      demoServiceBuild: null,
    };
    this.store.saveCycle(cycle);
    this.store.audit({ actor: config.requestedBy || 'unknown', actorType: 'human', action: 'cycle', target: cycle.id, details: { event: 'created', config } });
    return cycle;
  }

  isRunning(id: string): boolean {
    return this.active.has(id);
  }

  /** Runs stages until the next human gate, completion or failure. Safe to call repeatedly. */
  advance(id: string): Promise<Cycle> {
    const existing = this.active.get(id);
    if (existing) return existing;
    const p = this.run(id).finally(() => this.active.delete(id));
    this.active.set(id, p);
    return p;
  }

  async waitFor(id: string): Promise<Cycle> {
    await this.active.get(id);
    return this.store.getCycle(id)!;
  }

  private async run(id: string): Promise<Cycle> {
    let cycle = this.mustGet(id);
    if (cycle.status === 'completed' || cycle.status === 'rejected') return cycle;
    for (let i = 0; i < cycle.stages.length; i++) {
      cycle = this.mustGet(id);
      const stage = cycle.stages[i];
      if (stage.status === 'completed') continue;
      if (stage.status === 'rejected') break;
      if (stage.gate) {
        if (stage.status !== 'waiting-approval') {
          stage.status = 'waiting-approval';
          stage.startedAt = new Date().toISOString();
          stage.summary = `Waiting for a human decision at ${stage.name}.`;
        }
        cycle.status = 'waiting-approval';
        this.store.saveCycle(cycle);
        return cycle;
      }
      stage.status = 'running';
      stage.startedAt = new Date().toISOString();
      stage.error = null;
      cycle.status = 'running';
      this.store.saveCycle(cycle);
      if (process.env.AQE_SIMULATE_CRASH_AT === stage.id) {
        console.error(`[aqe] simulated crash at ${stage.id}`);
        process.exit(86);
      }
      try {
        const { outputs, summary } = await this.runStage(cycle, stage);
        cycle = this.mustGet(id);
        const s = cycle.stages.find((x) => x.id === stage.id)!;
        Object.assign(s, { status: 'completed', finishedAt: new Date().toISOString(), outputs, summary });
        this.store.saveCycle(cycle);
      } catch (err) {
        cycle = this.mustGet(id);
        const s = cycle.stages.find((x) => x.id === stage.id)!;
        Object.assign(s, { status: 'failed', finishedAt: new Date().toISOString(), error: (err as Error).message });
        cycle.status = 'failed';
        this.store.saveCycle(cycle);
        this.store.audit({ actor: stage.agent ?? 'system', actorType: 'agent', action: 'cycle', target: cycle.id, details: { event: 'stage-failed', stage: stage.id, error: (err as Error).message } });
        return cycle;
      }
    }
    cycle = this.mustGet(id);
    if (cycle.stages.every((s) => s.status === 'completed')) cycle.status = 'completed';
    this.store.saveCycle(cycle);
    return cycle;
  }

  /** Marks cycles whose stage was mid-flight when the process stopped as interrupted. */
  recoverInterrupted(): string[] {
    const ids: string[] = [];
    for (const c of this.store.listCycles()) {
      const running = c.stages.filter((s) => s.status === 'running');
      if (!running.length) continue;
      running.forEach((s) => Object.assign(s, { status: 'interrupted', error: 'Process stopped while this stage was running' }));
      c.status = 'interrupted';
      this.store.saveCycle(c);
      this.store.audit({ actor: 'platform', actorType: 'system', action: 'cycle', target: c.id, details: { event: 'interrupted', stages: running.map((s) => s.id) } });
      ids.push(c.id);
    }
    return ids;
  }

  resume(id: string, actor: string): Promise<Cycle> {
    const cycle = this.mustGet(id);
    if (!['interrupted', 'failed'].includes(cycle.status)) throw new GovernanceError(`Cycle ${id} is ${cycle.status}; only interrupted or failed cycles can be resumed.`);
    cycle.stages.filter((s) => s.status === 'interrupted' || s.status === 'failed').forEach((s) => Object.assign(s, { status: 'pending', error: null }));
    cycle.status = 'running';
    this.store.saveCycle(cycle);
    this.store.audit({ actor, actorType: 'human', action: 'cycle', target: id, details: { event: 'resumed' } });
    return this.advance(id);
  }

  /** Records a human decision at the gate currently waiting for approval. */
  approve(id: string, gate: GateId, req: ApprovalRequest): Cycle {
    const cycle = this.mustGet(id);
    const stage = cycle.stages.find((s) => s.gate === gate)!;
    if (!stage) throw new GovernanceError(`Unknown gate ${gate}`);
    if (stage.status !== 'waiting-approval') throw new GovernanceError(`${stage.name} is not waiting for approval (status ${stage.status}).`);
    const approver = validateApprover(req.approver);
    if (req.decision !== 'approved' && req.decision !== 'rejected') throw new GovernanceError('Decision must be approved or rejected.');
    const comments = (req.comments ?? '').trim();
    if (req.decision === 'rejected' && !comments) throw new GovernanceError('Comments are required when rejecting.');
    let findingDecisions: FindingDecision[] | undefined;
    if (gate === 'requirements-baseline') {
      const findings = this.store.readArtifact<ReviewFinding[]>(id, 'review/findings.json') ?? [];
      findingDecisions = (req.findingDecisions ?? []).filter((d) => findings.some((f) => f.id === d.findingId));
      const missing = findings.filter((f) => !findingDecisions!.some((d) => d.findingId === f.id && ['accept', 'reject', 'defer'].includes(d.decision)));
      if (req.decision === 'approved' && missing.length) throw new GovernanceError(`A decision is required for every review finding before the baseline can be approved (missing: ${missing.map((f) => f.id).join(', ')}).`);
    }
    const approval: Approval = { id: `APR-${pad(this.store.next('nextApproval'), 4)}`, gate, approver, decision: req.decision, comments, timestamp: new Date().toISOString(), ...(findingDecisions ? { findingDecisions } : {}) };
    cycle.approvals.push(approval);
    stage.finishedAt = approval.timestamp;
    stage.summary = `${req.decision === 'approved' ? 'Approved' : 'Rejected'} by ${approver}${comments ? `: ${comments}` : ''}`;
    this.store.audit({ actor: approver, actorType: 'human', action: 'approval', target: `${id}/${gate}`, details: { approvalId: approval.id, gate, decision: req.decision, comments, findingDecisions } });

    if (req.decision === 'rejected') {
      stage.status = 'rejected';
      cycle.status = 'rejected';
      this.store.saveCycle(cycle);
      if (gate === 'release') this.regenerateReports(cycle);
      return cycle;
    }
    stage.status = 'completed';
    if (gate === 'requirements-baseline') stage.outputs = this.baselineRequirements(cycle, approval);
    if (gate === 'release') {
      const baselineId = `BL-${pad(this.store.next('nextBaseline'), 4)}`;
      cycle.baselineId = baselineId;
      const b = loadBundle(this.store, cycle);
      this.store.saveBaseline(baselineId, {
        id: baselineId,
        cycleId: id,
        approvedBy: approver,
        approvedAt: approval.timestamp,
        requirements: b.requirements,
        rules: b.rules.map((r) => r.id),
        testCases: b.testCases.map((t) => t.id),
        scripts: b.scripts.map((s) => ({ id: s.id, sha256: s.sha256 })),
        results: b.execution?.results.map((r) => ({ id: r.id, status: r.status })) ?? [],
        defects: b.defects.map((d) => d.id),
      });
      stage.outputs = [{ label: `Final baseline ${baselineId}`, path: `state/baselines/${baselineId}.json` }, ...this.regenerateReports(cycle)];
      cycle.status = 'completed';
    } else cycle.status = 'running';
    this.store.saveCycle(cycle);
    return cycle;
  }

  private regenerateReports(cycle: Cycle): ArtifactRef[] {
    const b = loadBundle(this.store, cycle);
    const excluded = this.store.readArtifact<unknown[]>(cycle.id, 'tests/excluded.json')?.length ?? 0;
    return reportingAgent.writeReports(this.store, b, reportingAgent.computeMetrics(b, this.store, this.config, excluded));
  }

  private baselineRequirements(cycle: Cycle, approval: Approval): ArtifactRef[] {
    const draft = this.store.readArtifact<Requirement[]>(cycle.id, 'requirements/draft.json')!;
    const findings = this.store.readArtifact<ReviewFinding[]>(cycle.id, 'review/findings.json')!;
    const { baseline, acceptedCodeRules } = reviewAgent.applyDecisions(draft, findings, approval.findingDecisions ?? [], approval.approver);
    return [
      { label: 'Requirements baseline', path: this.store.artifact(cycle.id, 'requirements/baseline.json', baseline) },
      { label: 'Accepted code-only rules', path: this.store.artifact(cycle.id, 'requirements/accepted-code-rules.json', acceptedCodeRules) },
    ];
  }

  private mustGet(id: string): Cycle {
    const c = this.store.getCycle(id);
    if (!c) throw new GovernanceError(`Cycle ${id} not found`);
    return c;
  }

  private async runStage(cycle: Cycle, stage: StageState): Promise<{ outputs: ArtifactRef[]; summary: string }> {
    const s = this.store;
    const id = cycle.id;
    const inputs: Inputs = loadInputs(cycle.config.inputs);
    const out = (label: string, rel: string, value: unknown): ArtifactRef => ({ label, path: s.artifact(id, rel, value) });
    switch (stage.id) {
      case 'intake': {
        const manifest = inputs.documents.map(({ key, file, sha256, recordedFrom }) => ({ key, file, sha256, recordedFrom }));
        const outputs = [out('Input manifest (provenance)', 'inputs/manifest.json', manifest)];
        for (const d of inputs.documents.filter((x) => x.content)) outputs.push(out(`Input: ${d.key}`, `inputs/${d.key}.json`, d.content));
        return { outputs, summary: `${manifest.length} inputs loaded with sha256 provenance (${inputs.story.id}: ${inputs.story.title}).` };
      }
      case 'requirements': {
        const prev = cycle.previousBaselineId ? (s.getBaseline<{ requirements: Requirement[] }>(cycle.previousBaselineId)?.requirements ?? []) : [];
        const draft = requirementsAgent.normalizeRequirements(inputs, prev);
        const outputs = [out('Requirements repository (draft)', 'requirements/draft.json', draft)];
        if (cycle.config.mode === 'incremental') outputs.push(out('Changed since baseline', 'requirements/changes.json', requirementsAgent.changedSince(draft, prev)));
        return { outputs, summary: `${draft.length} requirements normalized (versions ${[...new Set(draft.map((r) => `v${r.version}`))].join(', ')}).` };
      }
      case 'review': {
        const draft = s.readArtifact<Requirement[]>(id, 'requirements/draft.json')!;
        const findings = reviewAgent.reviewRequirements(draft, inputs);
        const byType = (t: string) => findings.filter((f) => f.type === t).length;
        return { outputs: [out('Review findings (advisory)', 'review/findings.json', findings)], summary: `${findings.length} advisory findings: ${byType('missing')} missing, ${byType('duplicate')} duplicate, ${byType('conflict')} conflict, ${byType('code-only')} code-only. Nothing approved or changed.` };
      }
      case 'business-rules': {
        const baseline = s.readArtifact<Requirement[]>(id, 'requirements/baseline.json')!;
        const accepted = s.readArtifact<{ ruleId: string; text: string }[]>(id, 'requirements/accepted-code-rules.json') ?? [];
        const rules = rulesAgent.extractRules(baseline, inputs, accepted);
        return { outputs: [out('Business-rules catalogue', 'rules/business-rules.json', rules)], summary: `${rules.length} rules extracted (${rules.map((r) => r.id).join(', ')}), each linked to source requirements and code.` };
      }
      case 'test-design': {
        const baseline = s.readArtifact<Requirement[]>(id, 'requirements/baseline.json')!;
        const rules = s.readArtifact<BusinessRule[]>(id, 'rules/business-rules.json')!;
        const changed = cycle.config.mode === 'incremental' ? (s.readArtifact<string[]>(id, 'requirements/changes.json') ?? []) : null;
        const design = designAgent.designTests(rules, baseline, inputs, cycle.config, changed);
        return {
          outputs: [out('Test cases', 'tests/test-cases.json', design.testCases), out('Coverage matrix', 'tests/coverage-matrix.json', design.coverage), out('Excluded by selection', 'tests/excluded.json', design.excluded)],
          summary: `${design.testCases.length} test cases generated (${design.excluded.length} excluded by selection).`,
        };
      }
      case 'test-data': {
        const tcs = s.readArtifact<TestCase[]>(id, 'tests/test-cases.json')!;
        const dictSha = inputs.documents.find((d) => d.key === 'data-dictionary')!.sha256;
        const datasets = tcs.map((tc) => dataAgent.generateDataset(tc, inputs.dictionary, dictSha));
        const outputs = [out('Synthetic datasets', 'data/datasets.json', datasets)];
        datasets.forEach((d) => s.artifact(id, `data/datasets/${d.id}.json`, d));
        const invalid = datasets.filter((d) => d.validation.status !== 'valid');
        if (invalid.length) throw new Error(`Dataset validation failed: ${invalid.map((d) => d.id).join(', ')}`);
        return { outputs, summary: `${datasets.length} SYNTHETIC datasets generated and validated against data dictionary v${inputs.dictionary.version}.` };
      }
      case 'automation': {
        const tcs = s.readArtifact<TestCase[]>(id, 'tests/test-cases.json')!;
        const datasets = s.readArtifact<Dataset[]>(id, 'data/datasets.json')!;
        datasets.forEach((d) => dataAgent.assertProvenance(d, this.config.approvedDatasetGenerators));
        const rules = s.readArtifact<BusinessRule[]>(id, 'rules/business-rules.json')!;
        const dir = path.join(s.cycleDir(id), 'automation');
        fs.rmSync(dir, { recursive: true, force: true });
        const scripts = automationAgent.generateSuite(dir, s.home, tcs, datasets, rules, `cycle ${id}`);
        return {
          outputs: [out('Automation scripts', 'automation/scripts.json', scripts), { label: 'Playwright config', path: s.relPath(path.join(dir, 'playwright.config.ts')) }, { label: 'Shared fixtures', path: s.relPath(path.join(dir, 'support', 'aqe.ts')) }, { label: 'Page object', path: s.relPath(path.join(dir, 'support', 'reservation-console.ts')) }],
          summary: `${scripts.length} Playwright specs generated (${scripts.filter((x) => x.channel === 'ui').length} UI, ${scripts.filter((x) => x.channel === 'api').length} GraphQL API).`,
        };
      }
      case 'execution': {
        const scripts = s.readArtifact<import('./types').AutomationScript[]>(id, 'automation/scripts.json')!;
        const approval = [...cycle.approvals].reverse().find((a) => a.gate === 'execution' && a.decision === 'approved');
        if (!approval) throw new GovernanceError('Execution requires an approved execution gate.');
        s.audit({ actor: executionAgent.AGENT, actorType: 'agent', action: 'execution', target: id, details: { event: 'started', approvedBy: approval.approver, approvalId: approval.id, scripts: scripts.length } });
        const summary = await executionAgent.executeSuite({
          automationDir: path.join(s.cycleDir(id), 'automation'),
          runDir: path.join(s.cycleDir(id), 'execution'),
          home: s.home,
          scripts,
          runId: `RUN-${id}`,
          fixedDefects: cycle.config.fixedDefects,
          timeoutMs: this.config.executionTimeoutMs,
        });
        const c = this.mustGet(id);
        c.demoServiceBuild = summary.demoServiceBuild;
        s.saveCycle(c);
        s.audit({ actor: executionAgent.AGENT, actorType: 'agent', action: 'execution', target: id, details: { event: 'finished', totals: summary.totals, build: summary.demoServiceBuild, exitCode: summary.playwrightExitCode } });
        if (!summary.executed) throw new Error(`Playwright did not execute any test (exit code ${summary.playwrightExitCode}); see execution/playwright-output.log`);
        return {
          outputs: [out('Execution summary', 'execution/summary.json', summary), { label: 'Playwright JSON report (masked)', path: `cycles/${id}/execution/playwright-report.json` }, { label: 'Playwright output log', path: `cycles/${id}/execution/playwright-output.log` }],
          summary: `${summary.totals.total} tests: ${summary.totals.passed} passed, ${summary.totals.failed} failed against ${summary.demoServiceBuild}.`,
        };
      }
      case 'defects': {
        const b = loadBundle(s, cycle);
        const defects = defectAgent.createDefects({ results: b.execution?.results ?? [], testCases: b.testCases, rules: b.rules, datasets: b.datasets, home: s.home });
        const outputs = [out('Defects', 'defects/defects.json', defects)];
        for (const d of defects) {
          outputs.push(out(`${d.id} (${d.severity})`, `defects/${d.id}.json`, d));
          s.artifact(id, `defects/${d.id}.md`, `# ${d.id} ${d.title}\n\n- Severity: ${d.severity}${d.blocksRelease ? ' (blocks release)' : ''}\n- Rule: ${d.ruleId}\n- Requirements: ${d.requirementIds.join(', ')}\n- Test cases: ${d.testCaseIds.join(', ')}\n- Executions: ${d.executionIds.join(', ')}\n- Evidence: ${d.evidenceIds.join(', ')}\n\n## Expected\n${d.expected}\n\n## Actual\n${d.actual}\n\n## Impact\n${d.impact}\n\n## Suspected cause\n${d.suspectedCause}\n\n## Suggested remediation\n${d.suggestedRemediation}\n`);
        }
        const failed = b.execution?.totals.failed ?? 0;
        return { outputs, summary: failed ? `${defects.length} defect(s) created from ${failed} failed execution(s): ${defects.map((d) => d.id).join(', ')}.` : 'No failed executions, so no defects were created.' };
      }
      case 'reporting': {
        const outputs = this.regenerateReports(cycle);
        const b = loadBundle(s, this.mustGet(id));
        outputs.push({ label: 'Traceability (Excel)', path: s.artifact(id, 'traceability/traceability.xlsx', await traceWorkbook(b)) });
        const m = s.readArtifact<reportingAgent.Metrics>(id, 'reports/metrics.json')!;
        return { outputs, summary: `Recommendation ${m.recommendation.decision}: ${m.recommendation.reason}` };
      }
      default:
        throw new Error(`No implementation for stage ${stage.id}`);
    }
  }
}
