/** Loads every artifact of a cycle, builds the traceability graph and writes JSON/XLSX exports. */
import ExcelJS from 'exceljs';
import { Store } from './store';
import { CoverageRow } from './agents/test-design';
import { AutomationScript, BusinessRule, Cycle, Dataset, Defect, ExecutionSummary, Requirement, ReviewFinding, TestCase } from './types';

export interface Bundle {
  cycle: Cycle;
  requirements: Requirement[];
  findings: ReviewFinding[];
  rules: BusinessRule[];
  testCases: TestCase[];
  coverage: CoverageRow[];
  datasets: Dataset[];
  scripts: AutomationScript[];
  execution: ExecutionSummary | null;
  defects: Defect[];
}

export function loadBundle(store: Store, cycle: Cycle): Bundle {
  const a = <T>(p: string, fallback: T) => store.readArtifact<T>(cycle.id, p) ?? fallback;
  return {
    cycle,
    requirements: a<Requirement[]>('requirements/baseline.json', a<Requirement[]>('requirements/draft.json', [])),
    findings: a<ReviewFinding[]>('review/findings.json', []),
    rules: a<BusinessRule[]>('rules/business-rules.json', []),
    testCases: a<TestCase[]>('tests/test-cases.json', []),
    coverage: a<CoverageRow[]>('tests/coverage-matrix.json', []),
    datasets: a<Dataset[]>('data/datasets.json', []),
    scripts: a<AutomationScript[]>('automation/scripts.json', []),
    execution: a<ExecutionSummary | null>('execution/summary.json', null),
    defects: a<Defect[]>('defects/defects.json', []),
  };
}

export type NodeType = 'requirement' | 'rule' | 'test-case' | 'dataset' | 'script' | 'execution' | 'evidence' | 'defect' | 'report';

export interface TraceNode {
  id: string;
  type: NodeType;
  label: string;
  path: string | null;
  up: string[];
  down: string[];
}

export interface TraceRow {
  requirementId: string;
  requirement: string;
  ruleId: string;
  rule: string;
  testCaseId: string;
  testType: string;
  channel: string;
  datasetId: string;
  classification: string;
  scriptId: string;
  scriptFile: string;
  executionId: string;
  status: string;
  evidenceIds: string;
  defectIds: string;
  reportId: string;
}

export const reportId = (cycleId: string) => `RPT-${cycleId}-QE-LEAD`;

export function buildTrace(b: Bundle): { nodes: Record<string, TraceNode>; rows: TraceRow[] } {
  const nodes: Record<string, TraceNode> = {};
  const node = (id: string, type: NodeType, label: string, path: string | null = null) => (nodes[id] ??= { id, type, label, path, up: [], down: [] });
  const link = (from: string, to: string) => {
    if (!nodes[from] || !nodes[to]) return;
    if (!nodes[from].down.includes(to)) nodes[from].down.push(to);
    if (!nodes[to].up.includes(from)) nodes[to].up.push(from);
  };
  const c = b.cycle.id;
  const rpt = reportId(c);
  node(rpt, 'report', `QE lead report ${c}`, `cycles/${c}/reports/qe-lead-report.html`);
  for (const r of b.requirements) node(r.id, 'requirement', `${r.sourceId}: ${r.text}`, `cycles/${c}/requirements/baseline.json`);
  for (const r of b.rules) {
    node(r.id, 'rule', `${r.id}: ${r.text}`, `cycles/${c}/rules/business-rules.json`);
    r.sourceRequirements.forEach((q) => link(q, r.id));
  }
  for (const t of b.testCases) {
    node(t.id, 'test-case', `${t.id} [${t.type}/${t.channel}] ${t.title}`, `cycles/${c}/tests/test-cases.json`);
    t.ruleIds.forEach((r) => link(r, t.id));
  }
  for (const d of b.datasets) {
    node(d.id, 'dataset', `${d.id} SYNTHETIC v${d.version} (${d.validation.status})`, `cycles/${c}/data/datasets/${d.id}.json`);
    link(d.testCaseId, d.id);
  }
  for (const s of b.scripts) {
    node(s.id, 'script', `${s.id} ${s.file.split('/').pop()}`, s.file);
    link(s.datasetId, s.id);
  }
  for (const x of b.execution?.results ?? []) {
    node(x.id, 'execution', `${x.id} ${x.status.toUpperCase()} (${x.durationMs} ms)`, `cycles/${c}/execution/summary.json`);
    link(x.scriptId, x.id);
    for (const e of x.evidence) {
      node(e.id, 'evidence', `${e.id} ${e.kind}: ${e.label}`, e.path);
      link(x.id, e.id);
    }
    if (!b.defects.some((d) => d.executionIds.includes(x.id))) link(x.id, rpt);
  }
  for (const d of b.defects) {
    node(d.id, 'defect', `${d.id} [${d.severity}] ${d.title}`, `cycles/${c}/defects/${d.id}.md`);
    d.executionIds.forEach((x) => link(x, d.id));
    d.evidenceIds.forEach((e) => link(e, d.id));
    link(d.id, rpt);
  }

  const rows: TraceRow[] = [];
  for (const t of b.testCases) {
    const ds = b.datasets.find((d) => d.testCaseId === t.id);
    const s = b.scripts.find((x) => x.testCaseId === t.id);
    const x = b.execution?.results.find((r) => r.testCaseId === t.id);
    const defs = b.defects.filter((d) => d.testCaseIds.includes(t.id)).map((d) => d.id);
    for (const reqId of t.requirementIds) {
      for (const ruleId of t.ruleIds) {
        rows.push({
          requirementId: reqId,
          requirement: b.requirements.find((r) => r.id === reqId)?.text ?? '',
          ruleId,
          rule: b.rules.find((r) => r.id === ruleId)?.text ?? '',
          testCaseId: t.id,
          testType: t.type,
          channel: t.channel,
          datasetId: ds?.id ?? '',
          classification: ds?.classification ?? '',
          scriptId: s?.id ?? '',
          scriptFile: s?.file ?? '',
          executionId: x?.id ?? '',
          status: x?.status ?? 'not executed',
          evidenceIds: x?.evidence.map((e) => e.id).join(' ') ?? '',
          defectIds: defs.join(' '),
          reportId: b.execution ? rpt : '',
        });
      }
    }
  }
  for (const r of b.requirements.filter((q) => !rows.some((row) => row.requirementId === q.id))) {
    rows.push({ requirementId: r.id, requirement: r.text, ruleId: '', rule: '', testCaseId: '', testType: '', channel: '', datasetId: '', classification: '', scriptId: '', scriptFile: '', executionId: '', status: r.status === 'merged' ? `merged into ${r.mergedInto}` : 'no test', evidenceIds: '', defectIds: '', reportId: '' });
  }
  return { nodes, rows };
}

export function searchTrace(rows: TraceRow[], q: string): TraceRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(needle)));
}

export async function traceWorkbook(b: Bundle): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Agentic QE Platform (local)';
  const sheet = (name: string, rows: Record<string, unknown>[]) => {
    const ws = wb.addWorksheet(name);
    const cols = rows.length ? Object.keys(rows[0]) : ['empty'];
    ws.columns = cols.map((k) => ({ header: k, key: k, width: Math.min(60, Math.max(12, k.length + 2)) }));
    rows.forEach((r) => ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v]))));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const { rows } = buildTrace(b);
  sheet('Traceability', rows as unknown as Record<string, unknown>[]);
  sheet('Requirements', b.requirements.map((r) => ({ id: r.id, kind: r.kind, sourceId: r.sourceId, version: r.version, status: r.status, text: r.text, source: `${r.provenance.source}${r.provenance.path}`, reviewerNote: r.reviewerNote ?? '' })));
  sheet('Business Rules', b.rules.map((r) => ({ id: r.id, kind: r.kind, text: r.text, condition: r.condition, expectedOutcome: r.expectedOutcome, errorCode: r.check.errorCode ?? '', sourceRequirements: r.sourceRequirements.join(' '), code: r.codeReferences.map((c) => `${c.file}:${c.line}`).join(' ') })));
  sheet('Test Cases', b.testCases.map((t) => ({ id: t.id, type: t.type, channel: t.channel, priority: t.priority, title: t.title, rules: t.ruleIds.join(' '), requirements: t.requirementIds.join(' '), expected: t.expected.success ? `success ${t.expected.status}` : t.expected.errorCode })));
  sheet('Datasets', b.datasets.map((d) => ({ id: d.id, testCaseId: d.testCaseId, classification: d.classification, version: d.version, generator: d.provenance.generator, seed: d.provenance.seed, validation: d.validation.status, intentionalViolations: d.intentionalViolations.join(' ') })));
  sheet('Execution', (b.execution?.results ?? []).map((x) => ({ id: x.id, testCaseId: x.testCaseId, scriptId: x.scriptId, status: x.status, durationMs: x.durationMs, evidence: x.evidence.map((e) => e.id).join(' '), error: x.error?.message.split('\n')[0] ?? '' })));
  sheet('Defects', b.defects.map((d) => ({ id: d.id, severity: d.severity, blocksRelease: d.blocksRelease, rule: d.ruleId, testCases: d.testCaseIds.join(' '), title: d.title, expected: d.expected, actual: d.actual, suspectedCause: d.suspectedCause, remediation: d.suggestedRemediation })));
  sheet('Approvals', b.cycle.approvals.map((a) => ({ id: a.id, gate: a.gate, approver: a.approver, decision: a.decision, timestamp: a.timestamp, comments: a.comments })));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
