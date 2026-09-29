/* Agentic QE platform UI: hash-routed screens over the local /api. */
import type { Approval, AutomationScript, BusinessRule, Cycle, Dataset, Defect, ExecutionSummary, Requirement, ReviewFinding, StageState, TestCase } from '../platform/types';

interface Metrics {
  execution: { executed: boolean; total: number; passed: number; failed: number; notRun: number; passRate: number; durationMs: number; build: string | null };
  requirements: { active: number; covered: number; verified: number; failing: number; notCovered: number };
  rules: { total: number; verified: number; failing: number; untested: number; byRule: { id: string; tests: number; passed: number; failed: number; status: string }[] };
  testCases: { total: number; byType: Record<string, number>; byChannel: { ui: number; api: number } };
  datasets: { total: number; valid: number };
  defects: { total: number; blocking: number };
  approvals: { gate: string; status: string; approver: string | null; timestamp: string | null; comments: string | null }[];
  privacy: { checks: { name: string; passed: boolean; detail: string }[] };
  recommendation: { decision: string; reason: string; conditions: string[]; policy: { id: string; description: string; passed: boolean; outcomeIfFailed: string; detail: string }[] };
  risks: string[];
}
interface CoverageRow { requirementId: string; sourceId: string; text: string; ruleIds: string[]; testCaseIds: string[]; byType: Record<string, number>; coverage: string }
interface Bundle {
  cycle: Cycle; requirements: Requirement[]; findings: ReviewFinding[]; rules: BusinessRule[]; testCases: TestCase[]; coverage: CoverageRow[];
  datasets: Dataset[]; scripts: AutomationScript[]; execution: ExecutionSummary | null; defects: Defect[]; metrics: Metrics | null;
  excluded: { title: string; ruleId: string; reason: string }[]; manifest: { key: string; file: string; sha256: string; recordedFrom: string }[]; reportId: string;
}
interface TraceNode { id: string; type: string; label: string; path: string | null; up: string[]; down: string[] }
interface Overview {
  agents: { name: string; role: string }[]; gates: { id: string; name: string }[]; lineage: string[];
  stages: { id: string; name: string; agent: string | null; gate: string | null }[];
  cycles: { id: string; status: string; mode: string; createdAt: string; build: string | null; baselineId: string | null }[];
  latest: { id: string; status: string; metrics: Metrics | null } | null;
  interruptedOnStartup: string[];
  config: { evidenceRetentionDays: number; deleteEvidenceOnReset: boolean; maskSensitiveValues: boolean; localOnly: boolean };
  options: { testingTypes: string[]; skills: string[]; channels: string[]; inputs: string[] };
}
interface ChainLink { type: string; id: string; label: string; path?: string }
interface LabRun {
  id: string; scenario: string; status: string; approvedBy: string; createdAt: string; rulesFrom: string; blockedReason?: string;
  interpretation: { channel: string; ruleId: string; mutation: Record<string, unknown>; expectation: string; expectationSource: string; notes: string[] };
  testCase: TestCase; dataset: Dataset; script: AutomationScript | null; execution: ExecutionSummary['results'][number] | null; defects: Defect[]; chain: ChainLink[];
}

const view = document.getElementById('view')!;
const select = document.getElementById('cycle-select') as HTMLSelectElement;
let pollTimer: number | undefined;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const user = () => localStorage.getItem('aqe.user') ?? '';
const art = (p: string, label?: string) => `<a href="/artifacts/${encodeURI(p)}" target="_blank" data-testid="artifact-link">${esc(label ?? p.split('/').pop())}</a>`;
const pill = (s: string) => `<span class="pill s-${esc(s)}" data-status="${esc(s)}">${esc(s)}</span>`;
const table = (head: string[], rows: string[][], testid = '') => `<table ${testid ? `data-testid="${testid}"` : ''}><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', 'x-aqe-user': user() || 'anonymous' }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

function currentCycle(): string | null {
  return select.value || null;
}

async function refreshCycles(preferred?: string) {
  const cycles = await api<Cycle[]>('/api/cycles');
  const keep = preferred ?? (localStorage.getItem('aqe.cycle') || '');
  select.innerHTML = cycles.length ? cycles.map((c) => `<option value="${c.id}">${c.id} · ${c.status}</option>`).join('') : '<option value="">(no cycles)</option>';
  const pick = cycles.find((c) => c.id === keep)?.id ?? cycles.at(-1)?.id ?? '';
  select.value = pick;
  if (pick) localStorage.setItem('aqe.cycle', pick);
}
select.addEventListener('change', () => {
  localStorage.setItem('aqe.cycle', select.value);
  void route();
});

const trace = (cycleId: string, id: string, label?: string, type = '') => `<a class="t-${esc(type)}" href="#/trace/${cycleId}/${encodeURIComponent(id)}" data-testid="trace-link" data-node="${esc(id)}">${esc(label ?? id)}</a>`;

function noCycle() {
  return `<div class="card"><p>No cycle selected. <a href="#/run">Start a cycle</a> on the Run screen.</p></div>`;
}

function poll(ms: number, fn: () => Promise<boolean>) {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(async () => {
    if (await fn()) poll(ms, fn);
  }, ms);
}

function watchCycle(c: Cycle) {
  if (c.status === 'running') poll(1500, async () => {
    const fresh = await api<Cycle>(`/api/cycles/${c.id}`);
    if (fresh.status !== 'running' || JSON.stringify(fresh.stages.map((s) => s.status)) !== JSON.stringify(c.stages.map((s) => s.status))) {
      await refreshCycles(c.id);
      await route();
      return false;
    }
    return true;
  });
}

// ---------- Home ----------
async function home() {
  const o = await api<Overview>('/api/overview');
  const m = o.latest?.metrics;
  view.innerHTML = `
  <div class="card" data-testid="home">
    <h1>Agentic Quality Engineering — executive overview</h1>
    <p>Nine deterministic agents take STORY-001 (create a customer reservation) from recorded inputs to a rules-based release recommendation, running real Playwright UI and GraphQL tests against a local Salesforce-oriented demo service. Agents recommend; named humans approve at four mandatory gates.</p>
    ${o.interruptedOnStartup.length ? `<div class="notice warn">Interrupted cycles detected on startup: ${o.interruptedOnStartup.map((id) => `<a href="#/cycle/${id}">${id}</a>`).join(', ')} — resume them from Cycle Details.</div>` : ''}
    ${o.latest ? `<div class="kpis">
      <div class="kpi">Latest cycle<b><a href="#/cycle/${o.latest.id}">${o.latest.id}</a></b>${pill(o.latest.status)}</div>
      <div class="kpi">Recommendation<b data-testid="home-decision" class="${m?.recommendation.decision === 'Go' ? 'ok' : m ? 'bad' : ''}">${esc(m?.recommendation.decision ?? '—')}</b></div>
      <div class="kpi">Pass rate<b>${m ? `${m.execution.passRate}%` : '—'}</b></div>
      <div class="kpi">Open defects<b>${m?.defects.total ?? '—'}</b></div>
      <div class="kpi">Rules verified<b>${m ? `${m.rules.verified}/${m.rules.total}` : '—'}</b></div></div>` : '<p><a href="#/run">Start the first cycle →</a></p>'}
  </div>
  <div class="card"><h2>End-to-end traceability</h2><div class="chain" data-testid="lineage">${o.lineage.map((l) => `<span class="node">${esc(l)}</span>`).join('<span class="arrow">→</span>')}</div></div>
  <div class="card"><h2>Agent model</h2><div class="grid" data-testid="agents">${o.agents.map((a, i) => `<div class="kpi"><strong>${i + 1}. ${esc(a.name)}</strong><p class="small">${esc(a.role)}</p></div>`).join('')}</div></div>
  <div class="card"><h2>Human governance</h2>
    <p>Workflow stops at each gate until a named human records a decision with comments; every decision is timestamped in the audit log. Names that identify an agent, bot or system are refused.</p>
    <div class="chain">${o.stages.map((s) => `<span class="node ${s.gate ? 't-defect' : 't-test-case'}">${esc(s.gate ? `⛔ ${s.name}` : s.agent)}</span>`).join('<span class="arrow">→</span>')}</div>
    <p class="small">Privacy: synthetic data only · masking ${o.config.maskSensitiveValues ? 'on' : 'off'} · local only · evidence retention ${o.config.evidenceRetentionDays} days · delete evidence on reset: ${o.config.deleteEvidenceOnReset}</p>
  </div>
  <div class="card"><h2>Cycles</h2>${table(['Cycle', 'Mode', 'Status', 'Build', 'Baseline', 'Created'], o.cycles.map((c) => [`<a href="#/cycle/${c.id}">${c.id}</a>`, c.mode, pill(c.status), esc(c.build ?? ''), esc(c.baselineId ?? ''), esc(c.createdAt)]))}</div>`;
}

// ---------- Run ----------
async function run() {
  const o = await api<Overview>('/api/overview');
  const checks = (name: string, values: string[], required: string[] = []) => values.map((v) => `<label class="inline"><input type="checkbox" name="${name}" value="${v}" checked ${required.includes(v) ? 'disabled' : ''} data-testid="${name}-${v}"/> ${esc(v)}${required.includes(v) ? ' (required)' : ''}</label>`).join('');
  const hasBaseline = o.cycles.some((c) => c.baselineId);
  view.innerHTML = `
  <div class="card" data-testid="run">
    <h1>Run a QE cycle</h1>
    <div class="row">
      <label class="inline"><input type="radio" name="mode" value="baseline" checked data-testid="mode-baseline"/> Baseline run</label>
      <label class="inline"><input type="radio" name="mode" value="incremental" ${hasBaseline ? '' : 'disabled'} data-testid="mode-incremental"/> Incremental run ${hasBaseline ? '(changes since the last final baseline)' : '(needs an approved final baseline)'}</label>
    </div>
    <h3>Testing types</h3><div class="row">${checks('type', o.options.testingTypes)}</div>
    <h3>Channels</h3><div class="row">${checks('channel', o.options.channels)}</div>
    <h3>Inputs (recorded fixtures)</h3><div class="row">${checks('input', o.options.inputs, ['story', 'business-rules', 'data-dictionary', 'graphql-contract'])}</div>
    <h3>Skills</h3><div class="row">${checks('skill', o.options.skills)}</div>
    <div class="row">
      <label>Requested by<input id="requestedBy" value="${esc(user())}" placeholder="Your name" data-testid="requested-by"/></label>
      <label class="inline"><input type="checkbox" id="fixed" data-testid="fixed-build"/> Run against the fixed service build (BR-002 fix, for a re-test)</label>
      <button class="primary" id="start" data-testid="start-cycle">Start cycle</button>
    </div>
    <div id="run-msg"></div>
  </div>
  <div class="card"><h2>Resume</h2>${table(['Cycle', 'Status', ''], o.cycles.filter((c) => ['interrupted', 'failed', 'waiting-approval', 'running'].includes(c.status)).map((c) => [c.id, pill(c.status), ['interrupted', 'failed'].includes(c.status) ? `<button data-resume="${c.id}" data-testid="resume-${c.id}">Resume</button>` : `<a href="#/review/${c.id}">Continue in Human Review →</a>`]))}</div>`;
  const vals = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].filter((i) => i.checked).map((i) => i.value);
  document.getElementById('start')!.onclick = async () => {
    const requestedBy = (document.getElementById('requestedBy') as HTMLInputElement).value.trim();
    if (requestedBy) localStorage.setItem('aqe.user', requestedBy);
    try {
      const c = await api<Cycle>('/api/cycles', { method: 'POST', json: { mode: (document.querySelector('input[name="mode"]:checked') as HTMLInputElement).value, testingTypes: vals('type'), channels: vals('channel'), inputs: vals('input'), skills: vals('skill'), requestedBy, fixedDefects: (document.getElementById('fixed') as HTMLInputElement).checked ? ['BR-002'] : [] } });
      await refreshCycles(c.id);
      location.hash = `#/review/${c.id}`;
    } catch (e) {
      document.getElementById('run-msg')!.innerHTML = `<div class="notice error">${esc((e as Error).message)}</div>`;
    }
  };
  document.querySelectorAll<HTMLButtonElement>('[data-resume]').forEach((b) => (b.onclick = async () => {
    await api(`/api/cycles/${b.dataset.resume}/resume`, { method: 'POST', json: {} });
    await refreshCycles(b.dataset.resume);
    location.hash = `#/cycle/${b.dataset.resume}`;
  }));
}

// ---------- Human Review ----------
const GATE_TEXT: Record<string, string> = {
  'requirements-baseline': 'Approve the requirements baseline. Decide every review finding: only findings you accept change the baseline.',
  'test-design': 'Approve the generated test cases and coverage matrix.',
  execution: 'Approve execution of the generated automation against the local demo service.',
  release: 'Sign off the final baseline and the rules-based release recommendation.',
};

async function review(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  const c = b.cycle;
  const gate = c.stages.find((s) => s.status === 'waiting-approval');
  const history = table(['Approval', 'Gate', 'Decision', 'Approver', 'Timestamp', 'Comments'], c.approvals.map((a: Approval) => [a.id, a.gate, pill(a.decision), esc(a.approver), esc(a.timestamp), esc(a.comments)]), 'approval-history');
  let body = '';
  if (!gate) {
    body = c.status === 'running'
      ? `<div class="notice" data-testid="agents-working">Agents are working (${esc(c.stages.find((s) => s.status === 'running')?.name ?? '')})… this page refreshes automatically.</div>`
      : `<div class="notice ${c.status === 'completed' ? 'ok' : 'warn'}" data-testid="no-gate">No decision pending. Cycle status: ${esc(c.status)}. <a href="#/reporting/${id}">Open reporting →</a></div>`;
  } else {
    const g = gate.gate!;
    let content = '';
    if (g === 'requirements-baseline') {
      content = `<h3>Requirements (draft, versioned, with provenance)</h3>${table(['ID', 'Kind', 'Source', 'v', 'Text', 'Provenance'], b.requirements.map((r) => [r.id, r.kind, esc(r.sourceId), `v${r.version}`, esc(r.text), `<span class="small">${esc(r.provenance.source + r.provenance.path)}</span>`]), 'requirements-table')}
      <h3>Review Agent findings (advisory — the agent does not approve or change anything)</h3>
      ${b.findings.map((f) => `<div class="card" data-testid="finding" data-finding="${f.id}"><strong>${f.id} · ${esc(f.type)} · ${esc(f.severity)}</strong> — ${esc(f.title)}<p class="small">${esc(f.detail)}</p><p><em>Recommendation:</em> ${esc(f.recommendation)}</p>
        <div class="small">${f.evidence.map((e) => `“${esc(e.quote)}” — ${esc(e.source)}`).join('<br/>')}</div>
        <div class="row"><label>Decision<select data-decision="${f.id}" data-testid="decision-${f.id}"><option value="">— decide —</option><option value="accept">Accept</option><option value="reject">Reject</option><option value="defer">Defer</option></select></label>
        <label style="flex:1">Comment<input data-comment="${f.id}" data-testid="comment-${f.id}" placeholder="Reason for decision"/></label></div></div>`).join('')}`;
    } else if (g === 'test-design') {
      content = `<h3>Business rules</h3>${table(['Rule', 'Kind', 'Condition', 'Expected outcome', 'Source requirements', 'Code'], b.rules.map((r) => [r.id, r.kind, esc(r.condition), esc(r.expectedOutcome), r.sourceRequirements.join(', '), `<span class="small">${r.codeReferences.map((x) => `${esc(x.file)}:${x.line}`).join('<br/>')}</span>`]), 'rules-table')}
      <h3>Generated test cases (${b.testCases.length})</h3>${table(['ID', 'Type', 'Channel', 'Priority', 'Title', 'Rules', 'Expected'], b.testCases.map((t) => [t.id, t.type, t.channel, t.priority, esc(t.title), t.ruleIds.join(', '), t.expected.success ? `success ${esc(t.expected.status)}` : esc(t.expected.errorCode)]), 'testcase-table')}
      <h3>Coverage matrix</h3>${coverageTable(b)}
      ${b.excluded.length ? `<p class="small">Excluded by selection: ${b.excluded.map((e) => esc(`${e.title} (${e.reason})`)).join('; ')}</p>` : ''}`;
    } else if (g === 'execution') {
      content = `<h3>Generated automation (${b.scripts.length} Playwright specs) and SYNTHETIC datasets</h3>${table(['Script', 'Channel', 'Test case', 'Dataset', 'Dataset validation', 'Rules'], b.scripts.map((s) => [art(s.file, s.id), s.channel, s.testCaseId, s.datasetId, pill(b.datasets.find((d) => d.id === s.datasetId)?.validation.status ?? '?'), s.ruleIds.join(', ')]), 'script-table')}
      <p class="small">Execution starts the local demo service on 127.0.0.1 and runs the suite with Playwright (traces on). No external systems are contacted.</p>`;
    } else {
      const m = b.metrics!;
      content = `<div class="notice ${m.recommendation.decision === 'Go' ? 'ok' : 'error'}">Rules-based recommendation: <span class="decision" data-testid="gate-recommendation">${esc(m.recommendation.decision)}</span><br/>${esc(m.recommendation.reason)}</div>
        ${policyTable(m)}<p><a href="#/reporting/${id}">Full reporting →</a> · ${art(`cycles/${id}/reports/qe-lead-report.html`, 'QE lead report')}</p>`;
    }
    body = `<div class="notice warn" data-testid="gate-blocked">⛔ ${esc(gate.name)} — processing is blocked until a human decision is recorded. ${esc(GATE_TEXT[g])}</div>
      ${content}
      <div class="card"><div class="row">
        <label>Approver (human name)<input id="approver" value="${esc(user())}" data-testid="approver"/></label>
        <label style="flex:1">Comments<input id="comments" data-testid="comments" placeholder="Required when rejecting"/></label>
        <button class="primary" id="approve" data-testid="approve">Approve</button>
        <button class="danger" id="reject" data-testid="reject">Reject</button></div>
        <div id="gate-msg"></div></div>`;
  }
  view.innerHTML = `<div class="card" data-testid="review"><h1>Human Review — ${id}</h1>${body}</div><div class="card"><h2>Approval history</h2>${history}</div>`;
  watchCycle(c);
  if (!gate) return;
  const approveBtn = document.getElementById('approve') as HTMLButtonElement;
  const decisions = () => b.findings.map((f) => ({ findingId: f.id, decision: (document.querySelector(`[data-decision="${f.id}"]`) as HTMLSelectElement).value, comment: (document.querySelector(`[data-comment="${f.id}"]`) as HTMLInputElement).value }));
  const sync = () => {
    const pending = gate.gate === 'requirements-baseline' ? decisions().filter((d) => !d.decision).length : 0;
    approveBtn.disabled = pending > 0;
    approveBtn.title = pending ? `${pending} finding(s) still need a decision` : '';
  };
  document.querySelectorAll('[data-decision]').forEach((el) => el.addEventListener('change', sync));
  sync();
  const submit = async (decision: 'approved' | 'rejected') => {
    const approver = (document.getElementById('approver') as HTMLInputElement).value.trim();
    if (approver) localStorage.setItem('aqe.user', approver);
    try {
      await api(`/api/cycles/${id}/approvals`, { method: 'POST', json: { gate: gate.gate, approver, decision, comments: (document.getElementById('comments') as HTMLInputElement).value, findingDecisions: gate.gate === 'requirements-baseline' ? decisions() : undefined } });
      await refreshCycles(id);
      await route();
    } catch (e) {
      document.getElementById('gate-msg')!.innerHTML = `<div class="notice error" data-testid="gate-error">${esc((e as Error).message)}</div>`;
    }
  };
  approveBtn.onclick = () => submit('approved');
  (document.getElementById('reject') as HTMLButtonElement).onclick = () => submit('rejected');
}

function coverageTable(b: Bundle) {
  return table(['Requirement', 'Source', 'Rules', 'Smoke', 'Pos', 'Neg', 'Bnd', 'E2E', 'Coverage', 'Test cases'], b.coverage.map((r) => [trace(b.cycle.id, r.requirementId, r.requirementId, 'requirement'), esc(r.sourceId), r.ruleIds.join(' '), ...['smoke', 'positive', 'negative', 'boundary', 'e2e'].map((t) => String(r.byType[t] ?? 0)), pill(r.coverage.split(' ')[0] === 'not' ? 'untested' : r.coverage === 'covered' ? 'covered' : 'pending') + ` <span class="small">${esc(r.coverage)}</span>`, `<span class="small">${r.testCaseIds.join(' ')}</span>`]), 'coverage-matrix');
}

function policyTable(m: Metrics) {
  return table(['Rule', 'Release policy', 'Result', 'Outcome if failed', 'Detail'], m.recommendation.policy.map((p) => [p.id, esc(p.description), pill(p.passed ? 'pass' : 'FAIL'), esc(p.outcomeIfFailed), esc(p.detail)]), 'policy-table');
}

// ---------- Cycle Details ----------
async function cycleDetails(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  const c = b.cycle;
  view.innerHTML = `<div class="card" data-testid="cycle-details"><h1>Cycle ${c.id} ${pill(c.status)}</h1>
    <p class="small">Mode ${esc(c.config.mode)} · types ${esc(c.config.testingTypes.join(', '))} · channels ${esc(c.config.channels.join(', '))} · skills ${esc(c.config.skills.join(', '))} · requested by ${esc(c.config.requestedBy)} · build ${esc(c.demoServiceBuild ?? 'not executed')}${c.previousBaselineId ? ` · previous baseline ${c.previousBaselineId}` : ''}${c.baselineId ? ` · final baseline <strong>${c.baselineId}</strong>` : ''}</p>
    ${['interrupted', 'failed'].includes(c.status) ? `<div class="notice warn">This cycle was ${c.status}. Completed stages are kept. <button id="resume" data-testid="resume">Resume cycle</button></div>` : ''}
    ${c.status === 'waiting-approval' ? `<div class="notice warn">Waiting for a human decision. <a href="#/review/${id}">Open Human Review →</a></div>` : ''}
    ${table(['#', 'Stage', 'Agent / gate', 'Status', 'Started', 'Finished', 'Inputs', 'Outputs', 'Summary'], c.stages.map((s: StageState, i) => [String(i + 1), esc(s.name), esc(s.agent ?? `Human gate`), pill(s.status), `<span class="small">${esc(s.startedAt ?? '')}</span>`, `<span class="small">${esc(s.finishedAt ?? '')}</span>`, `<span class="small">${s.inputs.map(esc).join('<br/>')}</span>`, s.outputs.map((o) => art(o.path, o.label)).join('<br/>'), esc(s.error ?? s.summary ?? '')]), 'stage-table')}
  </div>
  <div class="card"><h2>Inputs and provenance</h2>${table(['Input', 'File', 'sha256', 'Recorded from'], b.manifest.map((d) => [d.key, esc(d.file), `<code>${esc(d.sha256.slice(0, 16))}</code>`, esc(d.recordedFrom)]))}</div>
  <div class="card"><h2>Approvals</h2>${table(['Approval', 'Gate', 'Decision', 'Approver', 'Timestamp', 'Comments'], c.approvals.map((a) => [a.id, a.gate, pill(a.decision), esc(a.approver), esc(a.timestamp), esc(a.comments)]))}</div>
  <div class="card"><h2>Requirements repository and business rules</h2>
    ${table(['Req', 'Kind', 'v', 'Status', 'Text', 'Note'], b.requirements.map((r) => [trace(id, r.id, r.id, 'requirement'), r.kind, `v${r.version}`, pill(r.status), esc(r.text), `<span class="small">${esc(r.reviewerNote ?? '')}</span>`]), 'baseline-table')}
    <h3>Business-rules catalogue</h3>${table(['Rule', 'Kind', 'Text', 'Error code', 'Source requirements', 'Origin'], b.rules.map((r) => [trace(id, r.id, r.id, 'rule'), r.kind, esc(r.text), esc(r.check.errorCode ?? ''), r.sourceRequirements.map((q) => trace(id, q, q, 'requirement')).join(' '), esc(r.origin)]), 'rules-catalogue')}
  </div>`;
  document.getElementById('resume')?.addEventListener('click', async () => {
    await api(`/api/cycles/${id}/resume`, { method: 'POST', json: {} });
    await refreshCycles(id);
    await route();
  });
  watchCycle(c);
}

// ---------- Test Data ----------
async function testData(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  view.innerHTML = `<div class="card" data-testid="test-data"><h1>Test Data — ${id}</h1>
  <p>One deterministic dataset per test case, generated by the Test Data Agent and validated against the data dictionary. Values containing personal or payment fields are masked on screen. <span class="pill synthetic">ALL DATA SYNTHETIC</span></p>
  ${b.datasets.length ? table(['Dataset', 'Class', 'Test case', 'Version', 'Provenance', 'Validation', 'Intentional violations', 'Values (masked)'], b.datasets.map((d) => [trace(id, d.id, d.id, 'dataset'), `<span class="pill synthetic" data-testid="classification">${d.classification}</span>`, trace(id, d.testCaseId, d.testCaseId, 'test-case'), `v${d.version}`, `<span class="small">${esc(d.provenance.generator)}<br/>seed ${esc(d.provenance.seed)}<br/>dictionary v${esc(d.provenance.dictionaryVersion)}</span>`, `${pill(d.validation.status)}<br/><span class="small">${d.validation.checks.length} checks, ${d.validation.privacy.length} privacy</span>`, esc(d.intentionalViolations.join(', ') || '—'), `<pre>${esc(JSON.stringify(d.values, null, 1))}</pre>`]), 'dataset-table') : '<p>Datasets are generated after gate 2 (test design) is approved.</p>'}
  </div>
  <div class="card"><h2>Provenance check</h2><p>Datasets with unknown provenance are rejected. Try it:</p><button id="probe" data-testid="probe-provenance">Submit a dataset with unknown provenance</button> <span id="probe-result" data-testid="probe-result"></span></div>`;
  document.getElementById('probe')!.onclick = async () => {
    const res = await fetch('/api/datasets/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'DS-UNKNOWN', classification: 'SYNTHETIC', provenance: { generator: 'unknown-export.csv' }, values: {} }) });
    const body = await res.json();
    document.getElementById('probe-result')!.innerHTML = `${pill(body.accepted ? 'pass' : 'rejected')} ${esc(body.reason ?? '')}`;
  };
}

// ---------- Execution ----------
async function execution(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  const ex = b.execution;
  const ev = (r: ExecutionSummary['results'][number]) => r.evidence.map((e) => e.kind === 'screenshot' ? `<a href="/artifacts/${encodeURI(e.path)}" target="_blank"><img class="shot" src="/artifacts/${encodeURI(e.path)}" alt="${esc(e.label)}" data-testid="screenshot"/></a>` : `${art(e.path, `${e.id} ${e.kind}`)}`).join('<br/>');
  view.innerHTML = `<div class="card" data-testid="execution"><h1>Execution — ${id}</h1>
  ${ex ? `<div class="kpis"><div class="kpi">Total<b>${ex.totals.total}</b></div><div class="kpi">Passed<b class="ok" data-testid="passed-count">${ex.totals.passed}</b></div><div class="kpi">Failed<b class="bad" data-testid="failed-count">${ex.totals.failed}</b></div><div class="kpi">Duration<b>${Math.round(ex.durationMs / 1000)} s</b></div><div class="kpi">Build<span class="small">${esc(ex.demoServiceBuild)}</span></div></div>
  <p class="small">Run ${esc(ex.runId)} · ${esc(ex.baseURL)} · started ${esc(ex.startedAt)} · ${art(`cycles/${id}/execution/playwright-report.json`, 'Playwright JSON report')} · ${art(`cycles/${id}/execution/playwright-output.log`, 'Playwright log')}</p>
  ${table(['Execution', 'Test case', 'Script', 'Dataset', 'Status', 'ms', 'Failure', 'Evidence'], ex.results.map((r) => [trace(id, r.id, r.id, 'execution'), trace(id, r.testCaseId, r.testCaseId, 'test-case'), art(b.scripts.find((s) => s.id === r.scriptId)?.file ?? '', r.scriptId), r.datasetId, pill(r.status), String(r.durationMs), r.error ? `<pre>${esc(r.error.message.split('\n').slice(0, 6).join('\n'))}</pre>` : '', ev(r)]), 'results-table')}`
    : `<p>Not executed yet. ${b.scripts.length ? `${b.scripts.length} scripts are waiting for the execution gate. <a href="#/review/${id}">Approve execution →</a>` : ''}</p>`}
  </div>
  <div class="card"><h2>Generated scripts</h2>${table(['Script', 'Channel', 'Test case', 'Dataset', 'Rules', 'Requirements', 'sha256'], b.scripts.map((s) => [art(s.file, s.id), s.channel, s.testCaseId, s.datasetId, s.ruleIds.join(' '), s.requirementIds.join(' '), `<code>${s.sha256.slice(0, 12)}</code>`]))}
  ${b.scripts.length ? `<p class="small">Shared utilities: ${art(`cycles/${id}/automation/support/aqe.ts`, 'support/aqe.ts')} · ${art(`cycles/${id}/automation/support/reservation-console.ts`, 'support/reservation-console.ts')} · ${art(`cycles/${id}/automation/playwright.config.ts`, 'playwright.config.ts')}</p>` : ''}</div>
  <div class="card"><h2>Defects (created only from failed executions)</h2>${defectCards(b)}</div>`;
  watchCycle(b.cycle);
}

function defectCards(b: Bundle) {
  const id = b.cycle.id;
  return b.defects.length ? b.defects.map((d) => `<div class="card" data-testid="defect" data-defect="${d.id}"><h3>${trace(id, d.id, d.id, 'defect')} <span class="pill s-failed">${esc(d.severity)}</span> ${d.blocksRelease ? '<span class="pill s-failed">blocks release</span>' : ''} ${esc(d.title)}</h3>
    <table><tr><th>Expected</th><td>${esc(d.expected)}</td></tr><tr><th>Actual</th><td data-testid="defect-actual">${esc(d.actual)}</td></tr><tr><th>Impact</th><td>${esc(d.impact)}</td></tr><tr><th>Suspected cause</th><td>${esc(d.suspectedCause)}</td></tr><tr><th>Suggested remediation</th><td>${esc(d.suggestedRemediation)}</td></tr>
    <tr><th>Traceability</th><td class="chain">${[...d.requirementIds.map((r) => trace(id, r, r, 'requirement')), trace(id, d.ruleId, d.ruleId, 'rule'), ...d.testCaseIds.map((t) => trace(id, t, t, 'test-case')), ...d.executionIds.map((x) => trace(id, x, x, 'execution'))].join(' ')}</td></tr>
    <tr><th>Evidence</th><td class="small">${d.evidenceIds.map((e) => trace(id, e, e, 'evidence')).join(' ')}</td></tr></table>
    ${d.codeReference ? `<pre>// ${esc(d.codeReference.file)}:${d.codeReference.line}\n${esc(d.codeReference.excerpt.join('\n'))}</pre>` : ''}</div>`).join('') : '<p>No defects.</p>';
}

// ---------- Reporting ----------
async function reporting(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  const m = b.metrics;
  if (!m) return (view.innerHTML = `<div class="card" data-testid="reporting"><h1>Reporting — ${id}</h1><p>Reports are produced after execution. Current status: ${pill(b.cycle.status)}</p></div>`);
  const tone = m.recommendation.decision === 'Go' ? 'ok' : m.recommendation.decision === 'Conditional go' ? 'warn' : 'error';
  const reports = ['qe-lead-report.html', 'qe-lead-report.md', 'executive-dashboard.html', 'cycle-report.md', 'coverage-report.md', 'execution-summary.md', 'defect-report.md', 'release-readiness.md', 'metrics.json'];
  view.innerHTML = `<div class="card" data-testid="reporting"><h1>Reporting — ${id}</h1>
    <div class="notice ${tone}">Rules-based release recommendation: <span class="decision" data-testid="recommendation">${esc(m.recommendation.decision)}</span><br/>${esc(m.recommendation.reason)}${m.recommendation.conditions.length ? `<ul>${m.recommendation.conditions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>
    <div class="kpis"><div class="kpi">Pass rate<b data-testid="pass-rate">${m.execution.passRate}%</b></div><div class="kpi">Executed<b>${m.execution.total}</b></div><div class="kpi">Failures<b class="bad">${m.execution.failed}</b></div><div class="kpi">Defects<b class="bad" data-testid="defect-count">${m.defects.total}</b></div>
    <div class="kpi">Requirements covered<b>${m.requirements.covered}/${m.requirements.active}</b></div><div class="kpi">Rules verified<b>${m.rules.verified}/${m.rules.total}</b></div><div class="kpi">Datasets valid<b>${m.datasets.valid}/${m.datasets.total}</b></div></div>
    <p>Reports: ${reports.map((r) => art(`cycles/${id}/reports/${r}`, r)).join(' · ')}<br/>Traceability export: <a href="/api/cycles/${id}/export.json" data-testid="export-json">JSON</a> · <a href="/api/cycles/${id}/export.xlsx" data-testid="export-xlsx">Excel</a> · QE lead report node: ${trace(id, b.reportId, b.reportId, 'report')}</p>
  </div>
  <div class="card"><h2>Release policy (deterministic, evaluated in order)</h2>${policyTable(m)}</div>
  <div class="card"><h2>Defects</h2>${defectCards(b)}</div>
  <div class="card"><h2>Coverage</h2>${coverageTable(b)}<h3>Rule verification</h3>${table(['Rule', 'Tests', 'Passed', 'Failed', 'Status'], m.rules.byRule.map((r) => [trace(id, r.id, r.id, 'rule'), String(r.tests), String(r.passed), String(r.failed), pill(r.status)]))}</div>
  <div class="card"><h2>Approval status</h2>${table(['Gate', 'Status', 'Approver', 'Timestamp', 'Comments'], m.approvals.map((a) => [a.gate, pill(a.status), esc(a.approver ?? ''), esc(a.timestamp ?? ''), esc(a.comments ?? '')]), 'report-approvals')}</div>
  <div class="card"><h2>Risks and gaps</h2><ul>${m.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>
  <div class="card"><h2>Privacy and security checks</h2>${table(['Check', 'Result', 'Detail'], m.privacy.checks.map((p) => [esc(p.name), pill(p.passed ? 'pass' : 'FAIL'), esc(p.detail)]), 'privacy-table')}</div>
  <div class="card"><h2>Traceability search</h2><div class="row"><input id="q" placeholder="Search e.g. BR-002, TC-004, DEF-001, customerCount" style="flex:1" data-testid="trace-search"/><button id="go">Search</button></div><div id="trace-rows"></div></div>`;
  const search = async () => {
    const q = (document.getElementById('q') as HTMLInputElement).value;
    const { rows } = await api<{ rows: Record<string, string>[] }>(`/api/cycles/${id}/trace?q=${encodeURIComponent(q)}`);
    const t = (v: string, type: string) => v ? v.split(' ').map((x) => trace(id, x, x, type)).join(' ') : '';
    document.getElementById('trace-rows')!.innerHTML = table(['Requirement', 'Rule', 'Test case', 'Dataset', 'Script', 'Execution', 'Status', 'Evidence', 'Defect', 'Report'], rows.map((r) => [t(r.requirementId, 'requirement'), t(r.ruleId, 'rule'), t(r.testCaseId, 'test-case'), t(r.datasetId, 'dataset'), t(r.scriptId, 'script'), t(r.executionId, 'execution'), pill(r.status), `<span class="small">${r.evidenceIds.split(' ').filter(Boolean).length} items</span>`, t(r.defectIds, 'defect'), t(r.reportId, 'report')]), 'trace-table');
  };
  document.getElementById('go')!.onclick = search;
  (document.getElementById('q') as HTMLInputElement).onkeydown = (e) => { if (e.key === 'Enter') void search(); };
  void search();
}

// ---------- Trace node ----------
async function traceNode(cycleId: string, nodeId: string) {
  const r = await api<{ node: TraceNode; data: unknown; up: TraceNode[]; down: TraceNode[]; lineage: TraceNode[] }>(`/api/cycles/${cycleId}/trace/${encodeURIComponent(nodeId)}`);
  const chip = (n: TraceNode) => trace(cycleId, n.id, `${n.type}: ${n.id}`, n.type);
  const order = ['report', 'defect', 'evidence', 'execution', 'script', 'dataset', 'test-case', 'rule', 'requirement'];
  const lineage = [...r.lineage].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const shot = r.node.type === 'evidence' && r.node.path?.endsWith('.png') ? `<img class="shot" src="/artifacts/${encodeURI(r.node.path)}" alt="screenshot"/>` : '';
  view.innerHTML = `<div class="card" data-testid="trace-node" data-node-type="${esc(r.node.type)}" data-node-id="${esc(r.node.id)}"><h1>${esc(r.node.type)} · ${esc(r.node.id)}</h1><p>${esc(r.node.label)}</p>${r.node.path ? `<p>Artifact: ${art(r.node.path)}</p>` : ''}${shot}
    <h3>Upstream lineage (back to the original requirement)</h3><div class="chain" data-testid="trace-lineage">${lineage.map(chip).join('<span class="arrow">←</span>') || '<span class="small">none (origin)</span>'}</div>
    <h3>Directly linked from</h3><div class="chain" data-testid="trace-up">${r.up.map(chip).join(' ') || '<span class="small">—</span>'}</div>
    <h3>Links to</h3><div class="chain" data-testid="trace-down">${r.down.map(chip).join(' ') || '<span class="small">—</span>'}</div>
    <h3>Record</h3><pre>${esc(JSON.stringify(r.data, null, 2))}</pre>
    <p><a href="#/reporting/${cycleId}">← back to Reporting</a></p></div>`;
}

// ---------- Test Lab ----------
const EXAMPLES = [
  'A reservation with customer count 0 should be rejected',
  'In the console, a reservation for 3 customers should be confirmed',
  'A reservation whose end date is before the start date should be rejected',
  'A reservation without an email should be rejected',
  'Payment method CASH should be rejected',
];

function labResult(r: LabRun) {
  const chain = r.chain.map((l) => `<span class="node t-${esc(l.type)}" data-testid="chain-${esc(l.type)}">${l.path ? `<a href="/artifacts/${encodeURI(l.path)}" target="_blank">${esc(l.id)}</a>` : esc(l.id)}<span class="small"> ${esc(l.type)}</span></span>`).join('<span class="arrow">→</span>');
  const shot = r.execution?.evidence.find((e) => e.kind === 'screenshot');
  return `<div class="card" data-testid="lab-result" data-status="${esc(r.status)}"><h2>${esc(r.id)} ${pill(r.status)}</h2><p>“${esc(r.scenario)}”</p>
    ${r.blockedReason ? `<div class="notice warn">${esc(r.blockedReason)}</div>` : ''}
    <table><tr><th>Interpretation</th><td>Rule ${esc(r.interpretation.ruleId)} · channel ${esc(r.interpretation.channel)} · expect <strong>${esc(r.interpretation.expectation)}</strong> (from ${esc(r.interpretation.expectationSource)}) · mutation <code>${esc(JSON.stringify(r.interpretation.mutation))}</code>${r.interpretation.notes.map((n) => `<br/><span class="small">${esc(n)}</span>`).join('')}</td></tr>
    <tr><th>Test case</th><td>${esc(r.testCase.id)} [${esc(r.testCase.type)}/${esc(r.testCase.channel)}] ${esc(r.testCase.title)}</td></tr>
    <tr><th>Dataset</th><td><span class="pill synthetic">${esc(r.dataset.classification)}</span> ${esc(r.dataset.id)} ${pill(r.dataset.validation.status)} <code class="small">${esc(JSON.stringify(r.dataset.values))}</code></td></tr>
    <tr><th>Script</th><td>${r.script ? art(r.script.file, r.script.id) : '—'}</td></tr>
    <tr><th>Execution</th><td>${r.execution ? `${pill(r.execution.status)} ${r.execution.durationMs} ms ${r.execution.error ? `<pre>${esc(r.execution.error.message.split('\n').slice(0, 5).join('\n'))}</pre>` : ''}` : '—'}${shot ? `<img class="shot" src="/artifacts/${encodeURI(shot.path)}" alt="screenshot"/>` : ''}</td></tr>
    <tr><th>Defects</th><td>${r.defects.map((d) => `<strong>${esc(d.id)}</strong> [${esc(d.severity)}] ${esc(d.title)}<br/><span class="small">${esc(d.suspectedCause)}</span>`).join('<br/>') || '—'}</td></tr></table>
    <h3>Traceability chain</h3><div class="chain" data-testid="lab-chain">${chain}</div><p class="small">Rules from ${esc(r.rulesFrom)} · approved by ${esc(r.approvedBy)} at ${esc(r.createdAt)}</p></div>`;
}

async function lab() {
  const runs = await api<LabRun[]>('/api/lab');
  view.innerHTML = `<div class="card" data-testid="lab"><h1>Test Lab</h1>
    <p>Describe a scenario in plain language. The platform deterministically maps it to a business rule, generates a test case, a SYNTHETIC dataset and a Playwright script, and — after you approve — executes it against the local demo service.</p>
    <textarea id="scenario" data-testid="lab-scenario" placeholder="e.g. A reservation with customer count 0 should be rejected"></textarea>
    <div class="row">${EXAMPLES.map((e, i) => `<button data-example="${i}" class="small">${esc(e)}</button>`).join('')}</div>
    <div class="row"><label>Approver (human name, approves execution)<input id="lab-approver" value="${esc(user())}" data-testid="lab-approver"/></label><button class="primary" id="lab-run" data-testid="lab-run">Generate, approve and execute</button></div>
    <div id="lab-msg"></div></div><div id="lab-out"></div>
    <div class="card"><h2>Previous lab runs</h2>${table(['Run', 'Scenario', 'Status', 'Rule', 'When'], runs.slice().reverse().map((r) => [esc(r.id), esc(r.scenario), pill(r.status), esc(r.interpretation.ruleId), esc(r.createdAt)]))}</div>`;
  document.querySelectorAll<HTMLButtonElement>('[data-example]').forEach((b) => (b.onclick = () => ((document.getElementById('scenario') as HTMLTextAreaElement).value = EXAMPLES[Number(b.dataset.example)])));
  document.getElementById('lab-run')!.onclick = async () => {
    const btn = document.getElementById('lab-run') as HTMLButtonElement;
    const approver = (document.getElementById('lab-approver') as HTMLInputElement).value.trim();
    if (approver) localStorage.setItem('aqe.user', approver);
    btn.disabled = true;
    document.getElementById('lab-msg')!.innerHTML = '<div class="notice" data-testid="lab-running">Generating and executing…</div>';
    try {
      const r = await api<LabRun>('/api/lab', { method: 'POST', json: { scenario: (document.getElementById('scenario') as HTMLTextAreaElement).value, approver } });
      document.getElementById('lab-msg')!.innerHTML = '';
      document.getElementById('lab-out')!.innerHTML = labResult(r);
    } catch (e) {
      document.getElementById('lab-msg')!.innerHTML = `<div class="notice error" data-testid="lab-error">${esc((e as Error).message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- Audit ----------
async function audit() {
  const entries = await api<{ seq: number; at: string; actor: string; actorType: string; action: string; target: string; details: unknown }[]>('/api/audit');
  view.innerHTML = `<div class="card" data-testid="audit"><h1>Audit log</h1><p class="small">Approvals, executions, access, reset, deletion and retention actions (masked, append-only JSONL).</p>
  <div class="row"><button id="retention" data-testid="apply-retention">Apply evidence-retention policy now</button></div>
  ${table(['#', 'When', 'Actor', 'Type', 'Action', 'Target', 'Details'], entries.slice().reverse().slice(0, 400).map((e) => [String(e.seq), `<span class="small">${esc(e.at)}</span>`, esc(e.actor), esc(e.actorType), pill(e.action), esc(e.target), `<span class="small">${esc(JSON.stringify(e.details)).slice(0, 300)}</span>`]), 'audit-table')}</div>`;
  document.getElementById('retention')!.onclick = async () => {
    await api('/api/retention/apply', { method: 'POST', json: {} });
    await audit();
  };
}

// ---------- Router ----------
async function route() {
  window.clearTimeout(pollTimer);
  const [, name = '', a, b] = location.hash.replace(/^#/, '').split('/');
  if (a && name !== 'trace' && select.value !== a && [...select.options].some((o) => o.value === a)) {
    select.value = a;
    localStorage.setItem('aqe.cycle', a);
  }
  document.querySelectorAll<HTMLAnchorElement>('.nav a').forEach((l) => {
    l.classList.toggle('active', l.dataset.route === (name || 'home'));
    const r = l.dataset.route!;
    if (['review', 'cycle', 'data', 'execution', 'reporting'].includes(r)) l.href = `#/${r}${currentCycle() ? `/${currentCycle()}` : ''}`;
  });
  const id = a ?? currentCycle();
  try {
    switch (name) {
      case '': return await home();
      case 'run': return await run();
      case 'review': return await review(id);
      case 'cycle': return await cycleDetails(id);
      case 'data': return await testData(id);
      case 'execution': return await execution(id);
      case 'reporting': return await reporting(id);
      case 'trace': return await traceNode(a!, decodeURIComponent(b!));
      case 'lab': return await lab();
      case 'audit': return await audit();
      default: view.innerHTML = '<div class="card">Not found</div>';
    }
  } catch (e) {
    view.innerHTML = `<div class="card notice error" data-testid="view-error">${esc((e as Error).message)}</div>`;
  }
}

window.addEventListener('hashchange', () => void route());
refreshCycles().then(route).then(() => document.body.setAttribute('data-ready', 'true'));
