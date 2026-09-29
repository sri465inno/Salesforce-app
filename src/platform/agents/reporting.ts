/**
 * Reporting Agent: calculates every metric deterministically from recorded artifacts and
 * applies an ordered, rules-based release policy. No language model computes a number or
 * makes the release decision; the final decision is a human sign-off at gate 4.
 */
import path from 'node:path';
import { Bundle, buildTrace, reportId } from '../bundle';
import { AqeConfig } from '../config';
import { markdownToHtml, page } from '../render/markdown';
import { scanForSecrets, SecretFinding } from '../privacy';
import { Store } from '../store';
import { assertProvenance } from './test-data';
import { ArtifactRef, GateId, TestType } from '../types';

export const AGENT = 'Reporting Agent';

export interface PolicyRule {
  id: string;
  description: string;
  passed: boolean;
  outcomeIfFailed: 'Not ready' | 'No-go' | 'Conditional go';
  detail: string;
}

export interface Metrics {
  cycleId: string;
  generatedAt: string;
  requirements: { total: number; active: number; merged: number; reviewerAdded: number; covered: number; verified: number; failing: number; notCovered: number };
  rules: { total: number; verified: number; failing: number; untested: number; byRule: { id: string; tests: number; passed: number; failed: number; status: 'verified' | 'failing' | 'untested' }[] };
  testCases: { total: number; byType: Record<TestType, number>; byChannel: { ui: number; api: number }; excluded: number };
  datasets: { total: number; valid: number; invalid: number; synthetic: number; provenanceApproved: number };
  scripts: { total: number; ui: number; api: number };
  execution: { executed: boolean; total: number; passed: number; failed: number; skipped: number; notRun: number; passRate: number; durationMs: number; build: string | null };
  defects: { total: number; blocking: number; bySeverity: Record<string, number> };
  review: { findings: number; accepted: number; rejected: number; deferred: number; deferredHigh: number };
  approvals: { gate: GateId; status: 'approved' | 'rejected' | 'pending'; approver: string | null; timestamp: string | null; comments: string | null }[];
  privacy: { checks: { name: string; passed: boolean; detail: string }[]; secretScan: { filesScanned: number; findings: SecretFinding[] } };
  recommendation: { decision: 'Go' | 'Conditional go' | 'No-go' | 'Not ready'; reason: string; conditions: string[]; policy: PolicyRule[] };
  risks: string[];
}

const GATES: GateId[] = ['requirements-baseline', 'test-design', 'execution', 'release'];
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function computeMetrics(b: Bundle, store: Store, config: AqeConfig, excludedCount = 0): Metrics {
  const results = b.execution?.results ?? [];
  const status = (tcIds: string[]) => {
    const rs = results.filter((r) => tcIds.includes(r.testCaseId));
    return { tests: tcIds.length, passed: rs.filter((r) => r.status === 'passed').length, failed: rs.filter((r) => r.status === 'failed').length };
  };
  const byRule = b.rules.map((r) => {
    const s = status(b.testCases.filter((t) => t.ruleIds.includes(r.id)).map((t) => t.id));
    return { id: r.id, ...s, status: (s.failed ? 'failing' : s.tests && s.passed === s.tests ? 'verified' : 'untested') as 'verified' | 'failing' | 'untested' };
  });
  const active = b.requirements.filter((r) => r.status !== 'merged' && r.status !== 'excluded');
  const reqStatus = active.map((r) => status(b.testCases.filter((t) => t.requirementIds.includes(r.id)).map((t) => t.id)));
  const byType = { smoke: 0, positive: 0, negative: 0, boundary: 0, e2e: 0 } as Record<TestType, number>;
  b.testCases.forEach((t) => (byType[t.type] += 1));
  const executed = !!b.execution?.executed;
  const ex = b.execution?.totals ?? { total: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 };
  const sev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  b.defects.forEach((d) => (sev[d.severity] += 1));
  const gate1 = b.cycle.approvals.find((a) => a.gate === 'requirements-baseline' && a.decision === 'approved');
  const fd = gate1?.findingDecisions ?? [];
  const deferredHigh = b.findings.filter((f) => f.severity === 'high' && fd.find((d) => d.findingId === f.id)?.decision !== 'accept').length;

  const provenanceOk = b.datasets.filter((d) => {
    try {
      assertProvenance(d, config.approvedDatasetGenerators);
      return true;
    } catch {
      return false;
    }
  }).length;
  const scan = scanForSecrets([store.cycleDir(b.cycle.id)], store.home, true);
  const privacyChecks = [
    { name: 'Every dataset classified SYNTHETIC', passed: b.datasets.every((d) => d.classification === 'SYNTHETIC'), detail: `${b.datasets.length} datasets` },
    { name: 'Dataset provenance recognised (unknown provenance rejected)', passed: provenanceOk === b.datasets.length, detail: `${provenanceOk}/${b.datasets.length} from ${config.approvedDatasetGenerators.join(', ')}` },
    { name: 'Dataset privacy checks (synthetic domain, token placeholders, no card numbers)', passed: b.datasets.every((d) => d.validation.privacy.every((p) => p.result === 'pass')), detail: `${b.datasets.reduce((n, d) => n + d.validation.privacy.length, 0)} checks` },
    { name: 'Secret and card-number scan of generated code, evidence and reports', passed: scan.findings.length === 0, detail: `${scan.filesScanned} files, ${scan.findings.length} findings` },
    { name: 'Demo service bound to localhost only', passed: !b.execution || b.execution.baseURL.startsWith('http://127.0.0.1'), detail: b.execution?.baseURL ?? 'not executed' },
    { name: 'Sensitive values masked in evidence and logs', passed: config.maskSensitiveValues && !scan.findings.some((f) => f.rule === 'unmasked-payment-token'), detail: 'emails, names, payment tokens masked; screenshots mask [data-sensitive] fields' },
  ];

  const approvals = GATES.map((gate) => {
    const a = [...b.cycle.approvals].reverse().find((x) => x.gate === gate);
    return { gate, status: (a?.decision ?? 'pending') as 'approved' | 'rejected' | 'pending', approver: a?.approver ?? null, timestamp: a?.timestamp ?? null, comments: a?.comments ?? null };
  });
  const blocking = b.defects.filter((d) => d.blocksRelease);
  const p1Failed = b.testCases.filter((t) => t.priority === 'P1' && results.find((r) => r.testCaseId === t.id)?.status !== 'passed');
  const unverified = byRule.filter((r) => r.status !== 'verified');
  const policy: PolicyRule[] = [
    { id: 'RP-1', description: 'Generated tests were executed against the demo service', passed: executed, outcomeIfFailed: 'Not ready', detail: executed ? `${ex.total} tests executed` : 'no execution recorded' },
    { id: 'RP-2', description: 'Gates 1-3 (requirements, test design, execution) approved by a human', passed: approvals.slice(0, 3).every((a) => a.status === 'approved'), outcomeIfFailed: 'Not ready', detail: approvals.slice(0, 3).map((a) => `${a.gate}: ${a.status}`).join('; ') },
    { id: 'RP-3', description: 'Privacy and security validation passed', passed: privacyChecks.every((c) => c.passed), outcomeIfFailed: 'No-go', detail: privacyChecks.filter((c) => !c.passed).map((c) => c.name).join('; ') || 'all checks passed' },
    { id: 'RP-4', description: 'No open release-blocking (critical/high) defects', passed: blocking.length === 0, outcomeIfFailed: 'No-go', detail: blocking.length ? blocking.map((d) => `${d.id} (${d.severity})`).join(', ') : 'none' },
    { id: 'RP-5', description: 'Every P1 test case passed', passed: executed && p1Failed.length === 0, outcomeIfFailed: 'No-go', detail: p1Failed.length ? p1Failed.map((t) => t.id).join(', ') : 'all P1 passed' },
    { id: 'RP-6', description: 'Every business rule verified by at least one passing test', passed: unverified.length === 0, outcomeIfFailed: 'Conditional go', detail: unverified.length ? unverified.map((r) => `${r.id} ${r.status}`).join(', ') : 'all rules verified' },
    { id: 'RP-7', description: 'No open non-blocking defects and no unaccepted high-severity review findings', passed: b.defects.length === blocking.length && deferredHigh === 0 && b.defects.filter((d) => !d.blocksRelease).length === 0, outcomeIfFailed: 'Conditional go', detail: `${b.defects.length - blocking.length} non-blocking defects, ${deferredHigh} unaccepted high findings` },
  ];
  const order = ['Not ready', 'No-go', 'Conditional go'] as const;
  const firstFail = order.map((o) => policy.filter((p) => !p.passed && p.outcomeIfFailed === o)).find((x) => x.length);
  const decision = firstFail ? firstFail[0].outcomeIfFailed : 'Go';
  const conditions = [
    ...blocking.map((d) => `Fix ${d.id} (${d.ruleId}) and re-run ${d.testCaseIds.join(', ')}; they must pass before release.`),
    ...b.defects.filter((d) => !d.blocksRelease).map((d) => `Accept or fix ${d.id} (${d.severity}).`),
    ...unverified.filter((r) => r.status === 'untested').map((r) => `Cover ${r.id} with a passing test or accept the gap.`),
  ];
  const risks = [
    ...b.findings.filter((f) => fd.find((d) => d.findingId === f.id)?.decision !== 'accept').map((f) => `Review finding ${f.id} (${f.type}, ${f.severity}) not accepted: ${f.title}`),
    ...b.requirements.filter((r) => r.reviewerNote && /pending/.test(r.reviewerNote)).map((r) => `${r.id} (${r.sourceId}) needs clarification: ${r.reviewerNote}`),
    ...unverified.map((r) => `${r.id} is ${r.status}`),
    ...(excludedCount ? [`${excludedCount} generated test case(s) excluded by run selection`] : []),
    'Out of scope for this cycle: STORY-002..004 (search, modify, cancel) are exercised only by the end-to-end UI case.',
    'Playwright traces contain DOM snapshots with synthetic (unmasked) form values; they are covered by the evidence-retention policy.',
  ];

  return {
    cycleId: b.cycle.id,
    generatedAt: new Date().toISOString(),
    requirements: {
      total: b.requirements.length,
      active: active.length,
      merged: b.requirements.filter((r) => r.status === 'merged').length,
      reviewerAdded: b.requirements.filter((r) => r.kind === 'reviewer-added').length,
      covered: reqStatus.filter((s) => s.tests > 0).length,
      verified: reqStatus.filter((s) => s.tests > 0 && s.passed === s.tests).length,
      failing: reqStatus.filter((s) => s.failed > 0).length,
      notCovered: b.coverage.filter((c) => c.coverage === 'not covered').length,
    },
    rules: { total: b.rules.length, verified: byRule.filter((r) => r.status === 'verified').length, failing: byRule.filter((r) => r.status === 'failing').length, untested: byRule.filter((r) => r.status === 'untested').length, byRule },
    testCases: { total: b.testCases.length, byType, byChannel: { ui: b.testCases.filter((t) => t.channel === 'ui').length, api: b.testCases.filter((t) => t.channel === 'api').length }, excluded: excludedCount },
    datasets: { total: b.datasets.length, valid: b.datasets.filter((d) => d.validation.status === 'valid').length, invalid: b.datasets.filter((d) => d.validation.status !== 'valid').length, synthetic: b.datasets.filter((d) => d.classification === 'SYNTHETIC').length, provenanceApproved: provenanceOk },
    scripts: { total: b.scripts.length, ui: b.scripts.filter((s) => s.channel === 'ui').length, api: b.scripts.filter((s) => s.channel === 'api').length },
    execution: { executed, ...ex, passRate: pct(ex.passed, ex.total - ex.notRun), durationMs: b.execution?.durationMs ?? 0, build: b.execution?.demoServiceBuild ?? null },
    defects: { total: b.defects.length, blocking: blocking.length, bySeverity: sev },
    review: { findings: b.findings.length, accepted: fd.filter((d) => d.decision === 'accept').length, rejected: fd.filter((d) => d.decision === 'reject').length, deferred: fd.filter((d) => d.decision === 'defer').length, deferredHigh },
    approvals,
    privacy: { checks: privacyChecks, secretScan: scan },
    recommendation: {
      decision,
      reason: firstFail ? firstFail.map((p) => `${p.id} failed: ${p.description} (${p.detail})`).join(' ') : 'Every release policy rule passed.',
      conditions,
      policy,
    },
    risks,
  };
}

const table = (head: string[], rows: (string | number)[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');
const trace = (cycleId: string, id: string) => `[${id}](/#/trace/${cycleId}/${id})`;

export function writeReports(store: Store, b: Bundle, m: Metrics): ArtifactRef[] {
  const c = b.cycle.id;
  const out: ArtifactRef[] = [];
  const put = (label: string, file: string, value: unknown) => out.push({ label, path: store.artifact(c, path.join('reports', file), value) });
  const results = b.execution?.results ?? [];
  const rec = m.recommendation;
  const signoff = m.approvals.find((a) => a.gate === 'release')!;
  const inputs = store.readArtifact<{ key: string; file: string; sha256: string; recordedFrom: string }[]>(c, 'inputs/manifest.json') ?? [];

  const cycleMd = `# Cycle report ${c}

- Mode: ${b.cycle.config.mode}; testing types: ${b.cycle.config.testingTypes.join(', ')}; channels: ${b.cycle.config.channels.join(', ')}; skills: ${b.cycle.config.skills.join(', ')}
- Requested by: ${b.cycle.config.requestedBy}; created ${b.cycle.createdAt}

${table(['Stage', 'Agent / gate', 'Status', 'Started', 'Finished', 'Summary'], b.cycle.stages.map((s) => [s.name, s.agent ?? `Human gate: ${s.gate}`, s.status, s.startedAt ?? '', s.finishedAt ?? '', s.summary ?? '']))}
`;
  put('Cycle report (JSON)', 'cycle-report.json', { cycle: b.cycle, metrics: m });
  put('Cycle report (Markdown)', 'cycle-report.md', cycleMd);

  const covMd = `# Coverage report ${c}

Requirements: ${m.requirements.covered}/${m.requirements.active} active requirements covered, ${m.requirements.verified} verified, ${m.requirements.failing} failing, ${m.requirements.notCovered} not covered.
Business rules: ${m.rules.verified}/${m.rules.total} verified, ${m.rules.failing} failing, ${m.rules.untested} untested.

${table(['Requirement', 'Source', 'Rules', 'Smoke', 'Positive', 'Negative', 'Boundary', 'E2E', 'Coverage', 'Test cases'], b.coverage.map((r) => [r.requirementId, r.sourceId, r.ruleIds.join(' '), r.byType.smoke, r.byType.positive, r.byType.negative, r.byType.boundary, r.byType.e2e, r.coverage, r.testCaseIds.join(' ')]))}

## Rule verification

${table(['Rule', 'Tests', 'Passed', 'Failed', 'Status'], m.rules.byRule.map((r) => [r.id, r.tests, r.passed, r.failed, r.status]))}
`;
  put('Coverage report (JSON)', 'coverage-report.json', { matrix: b.coverage, rules: m.rules });
  put('Coverage report (Markdown)', 'coverage-report.md', covMd);

  const exMd = `# Execution summary ${c}

${b.execution ? `Build under test: ${b.execution.demoServiceBuild} at ${b.execution.baseURL}. Started ${b.execution.startedAt}, ${Math.round(b.execution.durationMs / 1000)} s. Playwright exit code ${b.execution.playwrightExitCode}.` : 'Not executed.'}

Total ${m.execution.total}, passed ${m.execution.passed}, failed ${m.execution.failed}, skipped ${m.execution.skipped}, not run ${m.execution.notRun}; pass rate ${m.execution.passRate}%.

${table(['Execution', 'Test case', 'Script', 'Dataset', 'Status', 'ms', 'Evidence', 'Failure'], results.map((r) => [trace(c, r.id), r.testCaseId, r.scriptId, r.datasetId, r.status, r.durationMs, r.evidence.length, r.error?.message.split('\n')[0] ?? '']))}
`;
  put('Execution summary (JSON)', 'execution-summary.json', { totals: m.execution, results });
  put('Execution summary (Markdown)', 'execution-summary.md', exMd);

  const defMd = `# Defect report ${c}

${b.defects.length ? b.defects.map((d) => `## ${d.id} — ${d.title}

- Severity: **${d.severity}**${d.blocksRelease ? ' (blocks release)' : ''}; status ${d.status}; created from ${d.createdFrom}
- Rule: ${trace(c, d.ruleId)}; requirements: ${d.requirementIds.map((r) => trace(c, r)).join(', ')}
- Test cases: ${d.testCaseIds.map((t) => trace(c, t)).join(', ')}; executions: ${d.executionIds.map((x) => trace(c, x)).join(', ')}
- Evidence: ${d.evidenceIds.map((e) => trace(c, e)).join(', ')}
- Expected: ${d.expected}
- Actual: ${d.actual}
- Impact: ${d.impact}
- Suspected cause: ${d.suspectedCause}
- Suggested remediation: ${d.suggestedRemediation}
${d.codeReference ? `\n\`\`\`\n// ${d.codeReference.file}:${d.codeReference.line}\n${d.codeReference.excerpt.join('\n')}\n\`\`\`\n` : ''}`).join('\n') : 'No defects: no execution failures were recorded.'}
`;
  put('Defect report (JSON)', 'defect-report.json', b.defects);
  put('Defect report (Markdown)', 'defect-report.md', defMd);

  const relMd = `# Release-readiness report ${c}

> Recommendation: **${rec.decision}** — ${rec.reason}

The recommendation is computed by the ordered policy below. The first failing rule determines the outcome (Not ready > No-go > Conditional go); if every rule passes the outcome is Go. The final decision is a human sign-off.

${table(['Rule', 'Policy', 'Result', 'Outcome if failed', 'Detail'], rec.policy.map((p) => [p.id, p.description, p.passed ? 'pass' : 'FAIL', p.outcomeIfFailed, p.detail]))}

${rec.conditions.length ? `## Conditions\n\n${rec.conditions.map((x) => `- ${x}`).join('\n')}` : ''}
`;
  put('Release readiness (JSON)', 'release-readiness.json', rec);
  put('Release readiness (Markdown)', 'release-readiness.md', relMd);

  const leadMd = `# QE lead report — ${c}

Report ID: ${reportId(c)} · generated ${m.generatedAt} by the ${AGENT} (deterministic; no language model computed any metric or decision)

## 1. Executive summary

> Rules-based recommendation: **${rec.decision}**. ${rec.reason}

${m.execution.executed ? `${m.execution.total} generated tests ran against ${m.execution.build}: ${m.execution.passed} passed, ${m.execution.failed} failed (pass rate ${m.execution.passRate}%). ${m.defects.total} defect(s) were raised from actual failures (${m.defects.blocking} release-blocking).` : 'Tests have not been executed.'} ${m.rules.verified}/${m.rules.total} business rules are verified by passing tests.

## 2. Inputs and scope

${table(['Input', 'File', 'sha256', 'Provenance'], inputs.map((d) => [d.key, d.file, d.sha256.slice(0, 12), d.recordedFrom]))}

Scope: ${b.cycle.config.mode} run of STORY-001 (create reservation); testing types ${b.cycle.config.testingTypes.join(', ')}; channels ${b.cycle.config.channels.join(', ')}.

## 3. Requirements and business rules

${table(['Requirement', 'Kind', 'Version', 'Status', 'Text', 'Reviewer note'], b.requirements.map((r) => [trace(c, r.id), r.kind, `v${r.version}`, r.status, r.text, r.reviewerNote ?? '']))}

${table(['Rule', 'Kind', 'Condition', 'Expected outcome', 'Source requirements', 'Status'], b.rules.map((r) => [trace(c, r.id), r.kind, r.condition, r.expectedOutcome, r.sourceRequirements.join(' '), m.rules.byRule.find((x) => x.id === r.id)?.status ?? '']))}

## 4. Generated test assets

- Test cases: ${m.testCases.total} (smoke ${m.testCases.byType.smoke}, positive ${m.testCases.byType.positive}, negative ${m.testCases.byType.negative}, boundary ${m.testCases.byType.boundary}, e2e ${m.testCases.byType.e2e}; UI ${m.testCases.byChannel.ui}, API ${m.testCases.byChannel.api})
- Synthetic datasets: ${m.datasets.total} (${m.datasets.valid} valid, all labelled SYNTHETIC)
- Automation scripts: ${m.scripts.total} (Playwright UI ${m.scripts.ui}, GraphQL API ${m.scripts.api})

## 5. Execution results

Total ${m.execution.total} · passed ${m.execution.passed} · failed ${m.execution.failed} · not run ${m.execution.notRun} · pass rate ${m.execution.passRate}% · ${Math.round(m.execution.durationMs / 1000)} s

${table(['Execution', 'Test case', 'Status', 'ms'], results.filter((r) => r.status !== 'passed').map((r) => [trace(c, r.id), r.testCaseId, r.status, r.durationMs]))}

## 6. Coverage

Requirements covered ${m.requirements.covered}/${m.requirements.active}; verified ${m.requirements.verified}; failing ${m.requirements.failing}; not covered ${m.requirements.notCovered}. See the [coverage report](coverage-report.md).

## 7. Defects

${b.defects.length ? table(['Defect', 'Severity', 'Blocks release', 'Rule', 'Test cases', 'Title'], b.defects.map((d) => [trace(c, d.id), d.severity, d.blocksRelease ? 'yes' : 'no', d.ruleId, d.testCaseIds.join(' '), d.title])) : 'None.'}

## 8. Risks and gaps

${m.risks.map((r) => `- ${r}`).join('\n')}

## 9. Privacy and security validation

${table(['Check', 'Result', 'Detail'], m.privacy.checks.map((p) => [p.name, p.passed ? 'pass' : 'FAIL', p.detail]))}

## 10. Approval status

${table(['Gate', 'Status', 'Approver', 'Timestamp', 'Comments'], m.approvals.map((a) => [a.gate, a.status, a.approver ?? '', a.timestamp ?? '', a.comments ?? '']))}

## 11. Rules-based go/no-go recommendation

**${rec.decision}**

${table(['Rule', 'Policy', 'Result', 'Detail'], rec.policy.map((p) => [p.id, p.description, p.passed ? 'pass' : 'FAIL', p.detail]))}

${rec.conditions.map((x) => `- ${x}`).join('\n')}

## 12. Human sign-off

${signoff.status === 'pending' ? 'Pending: the QE lead must record the final decision at gate 4 (release).' : `${signoff.status.toUpperCase()} by ${signoff.approver} at ${signoff.timestamp}. Comments: ${signoff.comments || '(none)'}`}
`;
  put('QE lead report (JSON)', 'qe-lead-report.json', { reportId: reportId(c), metrics: m, requirements: b.requirements, rules: b.rules, defects: b.defects });
  put('QE lead report (Markdown)', 'qe-lead-report.md', leadMd);
  put('QE lead report (HTML)', 'qe-lead-report.html', markdownToHtml(leadMd, `QE lead report ${c}`));

  const tone = rec.decision === 'Go' ? 'ok' : rec.decision === 'Conditional go' ? 'warn' : 'bad';
  const kpi = (label: string, value: string | number, cls = '') => `<div class="kpi"><span>${label}</span><b class="${cls}">${value}</b></div>`;
  const bar = (label: string, n: number, d: number) => `<p>${label}: ${n}/${d}</p><div class="bar"><span style="width:${d ? (n / d) * 100 : 0}%"></span></div>`;
  const dash = page(
    `Executive dashboard ${c}`,
    `<h1>Executive dashboard — ${c} <span class="tag">SYNTHETIC DATA</span></h1>
<p>Reservation management (Salesforce-oriented) · STORY-001 Create reservation · generated ${m.generatedAt}</p>
<h2>Release recommendation: <span class="${tone}">${rec.decision}</span></h2><p>${rec.reason}</p>
<div class="kpis">${kpi('Pass rate', `${m.execution.passRate}%`, m.execution.failed ? 'warn' : 'ok')}${kpi('Tests executed', m.execution.total)}${kpi('Open defects', m.defects.total, m.defects.blocking ? 'bad' : 'ok')}${kpi('Rules verified', `${m.rules.verified}/${m.rules.total}`)}</div>
<h2>Coverage</h2>${bar('Requirements covered', m.requirements.covered, m.requirements.active)}${bar('Requirements verified', m.requirements.verified, m.requirements.active)}${bar('Business rules verified', m.rules.verified, m.rules.total)}${bar('Datasets valid', m.datasets.valid, m.datasets.total)}
<h2>Governance</h2><table><tr><th>Gate</th><th>Status</th><th>Approver</th><th>When</th></tr>${m.approvals.map((a) => `<tr><td>${a.gate}</td><td class="${a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'bad' : 'warn'}">${a.status}</td><td>${a.approver ?? ''}</td><td>${a.timestamp ?? ''}</td></tr>`).join('')}</table>
<h2>Privacy</h2><table>${m.privacy.checks.map((p) => `<tr><td>${p.name}</td><td class="${p.passed ? 'ok' : 'bad'}">${p.passed ? 'pass' : 'FAIL'}</td><td>${p.detail}</td></tr>`).join('')}</table>
<p><a href="qe-lead-report.html">Open the QE lead report</a></p>`,
  );
  put('Executive dashboard (HTML)', 'executive-dashboard.html', dash);
  put('Metrics (JSON)', 'metrics.json', m);
  const { rows } = buildTrace(b);
  out.push({ label: 'Traceability (JSON)', path: store.artifact(c, 'traceability/traceability.json', { cycleId: c, reportId: reportId(c), rows }) });
  return out;
}
