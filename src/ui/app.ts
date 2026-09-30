/* Agentic QE platform UI: hash-routed, Lightning-style screens over the local /api. */
import type { AutomationScript, BusinessRule, Cycle, Dataset, Defect, ExecutionSummary, Requirement, ReviewFinding, StageState, TestCase } from '../platform/types';

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
type ExecResult = ExecutionSummary['results'][number];

const view = document.getElementById('view')!;
const select = document.getElementById('cycle-select') as HTMLSelectElement;
let pollTimer: number | undefined;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const user = () => localStorage.getItem('aqe.user') ?? '';
const art = (p: string, label?: string) => `<a href="/artifacts/${encodeURI(p)}" target="_blank" data-testid="artifact-link">${esc(label ?? p.split('/').pop())}</a>`;
const table = (head: string[], rows: string[][], testid = '') => `<div class="tbl-wrap"><table ${testid ? `data-testid="${testid}"` : ''}><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const time = (iso: string | null | undefined) => (iso ? esc(iso.replace('T', ' ').slice(0, 16)) : '—');

const TONES: Record<string, string[]> = {
  success: ['completed', 'passed', 'approved', 'valid', 'pass', 'verified', 'covered', 'accepted', 'Go', 'done', 'ready'],
  error: ['failed', 'rejected', 'FAIL', 'invalid', 'failing', 'No-go', 'blocked'],
  warning: ['waiting-approval', 'running', 'interrupted', 'pending', 'untested', 'Conditional go', 'Not ready', 'partial'],
};
const tone = (s: string) => Object.keys(TONES).find((k) => TONES[k].includes(s)) ?? 'neutral';
const pill = (s: string, label = s) => `<span class="badge b-${tone(s)}" data-status="${esc(s)}">${esc(label)}</span>`;
const synthetic = (testid = '') => `<span class="badge synthetic" ${testid ? `data-testid="${testid}"` : ''}>SYNTHETIC</span>`;
const icon = (text: string, color: string, sm = false) => `<span class="tile-icon ${sm ? 'sm' : ''}" style="background:${color}">${esc(text)}</span>`;
const COLORS = { requirement: '#7f8de1', rule: '#3ba755', 'test-case': '#0176d3', dataset: '#fcb95b', script: '#a094ed', execution: '#06a59a', evidence: '#706e6b', defect: '#ba0517', report: '#032d60', gate: '#fe9339', audit: '#747474', lab: '#9050e9' } as Record<string, string>;

function pageHeader(o: { icon: string; color: string; eyebrow: string; title: string; fields?: [string, string][]; actions?: string }) {
  return `<section class="page-header"><div class="ph-top">${icon(o.icon, o.color)}<div><span class="eyebrow">${esc(o.eyebrow)}</span><h1>${o.title}</h1></div>${o.actions ? `<div class="ph-actions">${o.actions}</div>` : ''}</div>
    ${o.fields?.length ? `<div class="ph-fields">${o.fields.map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>` : ''}</section>`;
}
function card(title: string, body: string, o: { icon?: string; color?: string; actions?: string; testid?: string; cls?: string } = {}) {
  return `<article class="card ${o.cls ?? ''}" ${o.testid ? `data-testid="${o.testid}"` : ''}><header class="card-h">${o.icon ? icon(o.icon, o.color ?? '#0176d3', true) : ''}<h2>${title}</h2>${o.actions ? `<div class="card-a">${o.actions}</div>` : ''}</header><div class="card-b">${body}</div></article>`;
}
const acc = (title: string, body: string, count = '', open = false) => `<details class="acc" ${open ? 'open' : ''}><summary>${title}${count ? `<span class="count">${esc(count)}</span>` : ''}</summary><div class="acc-b">${body}</div></details>`;
const stat = (label: string, value: string, o: { tone?: string; testid?: string; sub?: string } = {}) => `<div class="stat ${o.tone ?? ''}"><span>${esc(label)}</span><b ${o.testid ? `data-testid="${o.testid}"` : ''}>${value}</b>${o.sub ? `<small>${o.sub}</small>` : ''}</div>`;
const decisionTone = (d: string) => (d === 'Go' ? 'ok' : d === 'Conditional go' ? 'warn' : 'error');

async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', 'x-aqe-user': user() || 'anonymous' }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

function currentCycle(): string | null {
  return select.value || null;
}

function setAvatar() {
  const name = user().trim();
  const el = document.getElementById('avatar');
  if (el) el.textContent = name ? name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() : '?';
}
function remember(name: string) {
  if (name) localStorage.setItem('aqe.user', name);
  setAvatar();
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
  return `<div class="notice">No cycle selected. <a href="#/run">Start a cycle</a> on the Run screen.</div>`;
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

// ---------- Shared: lifecycle path ----------
const PHASES: { label: string; stages: string[] }[] = [
  { label: 'Intake & review', stages: ['intake', 'requirements', 'review'] },
  { label: 'Gate 1', stages: ['gate-requirements-baseline'] },
  { label: 'Rules & design', stages: ['business-rules', 'test-design'] },
  { label: 'Gate 2', stages: ['gate-test-design'] },
  { label: 'Data & automation', stages: ['test-data', 'automation'] },
  { label: 'Gate 3', stages: ['gate-execution'] },
  { label: 'Execute & report', stages: ['execution', 'defects', 'reporting'] },
  { label: 'Gate 4', stages: ['gate-release'] },
];
function cyclePath(c: Cycle) {
  return `<ol class="path" data-testid="cycle-path">${PHASES.map((p) => {
    const st = c.stages.filter((s) => p.stages.includes(s.id));
    const cls = !st.length || st.every((s) => s.status === 'completed') ? (st.length ? 'p-complete' : '')
      : st.some((s) => ['failed', 'rejected'].includes(s.status)) ? 'p-error'
      : st.some((s) => s.status === 'waiting-approval') ? 'p-waiting'
      : st.some((s) => s.status !== 'pending') ? 'p-current' : '';
    return `<li class="${cls}" title="${esc(st.map((s) => `${s.name}: ${s.status}`).join('\n'))}">${cls === 'p-complete' ? '✓ ' : ''}${esc(p.label)}</li>`;
  }).join('')}</ol>`;
}
const gatesApproved = (c: Cycle) => c.stages.filter((s) => s.gate && s.status === 'completed').length;

// ---------- Home ----------
const AGENT_SHORT: Record<string, string> = {
  'Review Agent': 'Flags missing, duplicate and conflicting requirements. Advisory only.',
  'Requirements Agent': 'Versioned requirements repository with source provenance.',
  'Business Rules Agent': 'Validations and outcomes linked to requirements and code.',
  'Test Design Agent': 'Smoke, positive, negative, boundary and E2E cases plus coverage.',
  'Test Data Agent': 'One deterministic SYNTHETIC dataset per test case.',
  'Automation Agent': 'Playwright UI and GraphQL API specs with shared utilities.',
  'Execution Agent': 'Runs the suite locally and captures evidence.',
  'Defect Intelligence Agent': 'Raises defects only from real execution failures.',
  'Reporting Agent': 'Deterministic metrics and a rules-based go/no-go.',
};
const GATE_SHORT: Record<string, string> = {
  'requirements-baseline': 'Accept or reject every review finding',
  'test-design': 'Sign off test cases and coverage',
  execution: 'Allow automation to run',
  release: 'Sign off final baseline and recommendation',
};

async function home() {
  const o = await api<Overview>('/api/overview');
  const m = o.latest?.metrics;
  const d = m?.recommendation.decision;
  view.innerHTML = `
  <section class="hero" data-testid="home">
    <div>
      <span class="eyebrow">Agentic Quality Engineering · Reservation Management</span>
      <h1>From user story to release decision, with a person approving every step.</h1>
      <p>Agents turn STORY-001 into rules, tests, synthetic data and Playwright automation, run it against the local demo app and report a rules-based go/no-go.</p>
      <div class="hero-cta"><a class="btn inverse" href="#/run">Start a cycle</a><a class="btn outline-inverse" href="#/lab">Open Test Lab</a>${o.latest ? `<a class="btn outline-inverse" href="#/reporting/${o.latest.id}">Latest report</a>` : ''}</div>
    </div>
    ${o.latest ? `<div class="hero-side"><span>Latest cycle · <a href="#/cycle/${o.latest.id}">${o.latest.id}</a></span>
      <div class="big ${d ? decisionTone(d).replace('error', 'bad') : ''}" data-testid="home-decision">${esc(d ?? o.latest.status)}</div>
      <div class="row2"><div><span>Pass rate</span><b>${m ? `${m.execution.passRate}%` : '—'}</b></div><div><span>Defects</span><b>${m?.defects.total ?? '—'}</b></div><div><span>Rules</span><b>${m ? `${m.rules.verified}/${m.rules.total}` : '—'}</b></div></div></div>` : ''}
  </section>
  ${o.interruptedOnStartup.length ? `<div class="notice warn mt">Interrupted cycles found on startup: ${o.interruptedOnStartup.map((id) => `<a href="#/cycle/${id}">${id}</a>`).join(', ')}. Resume them from Cycle Details.</div>` : ''}
  <div class="stats">
    ${stat('Agents', String(o.agents.length), { sub: 'Review through Reporting' })}
    ${stat('Human gates', String(o.gates.length), { tone: 'warn', sub: 'Agents recommend, people approve' })}
    ${stat('Traceability', `${o.lineage.length} links`, { sub: 'Requirement to report' })}
    ${stat('Test data', '100%', { tone: 'ok', sub: 'Synthetic, local only' })}
  </div>
  <h2 class="section-title">How it works</h2>
  <ol class="lifecycle">
    <li><span class="lc-k">1 · Inputs</span><b>Load the story</b>Story, rules, GraphQL contract, data dictionary</li>
    <li><span class="lc-k">2 · Design</span><b>Rules to tests</b>Business rules, test cases and coverage</li>
    <li><span class="lc-k">3 · Build</span><b>Data and automation</b>Synthetic datasets and Playwright specs</li>
    <li><span class="lc-k">4 · Validate</span><b>Execute</b>Real runs with evidence and defects</li>
    <li><span class="lc-k">5 · Release</span><b>Decide</b>Rules-based go/no-go and sign-off</li>
  </ol>
  <div class="grid-2">
    ${card('Agent model', `<div class="agent-grid" data-testid="agents">${o.agents.map((a, i) => `<div class="agent" title="${esc(a.role)}"><span class="num">${i + 1}</span><div><b>${esc(a.name)}</b><small>${esc(AGENT_SHORT[a.name] ?? a.role)}</small></div></div>`).join('')}</div>`, { icon: 'AG', color: '#0176d3' })}
    <div class="stack">
      ${card('Human governance', `<ul class="gate-list">${o.gates.map((g, i) => `<li>${icon(`G${i + 1}`, COLORS.gate, true)}<div><b>${esc(g.name)}</b><small>${esc(GATE_SHORT[g.id] ?? '')}</small></div></li>`).join('')}</ul>`, { icon: 'HG', color: COLORS.gate })}
      ${card('End-to-end traceability', `<div class="chain" data-testid="lineage">${o.lineage.map((l) => `<span class="node">${esc(l)}</span>`).join('<span class="arrow">›</span>')}</div>`, { icon: 'TR', color: COLORS.report })}
    </div>
  </div>`;
}

// ---------- Run ----------
const INPUT_LABELS: Record<string, string> = {
  initiative: 'Initiative', epic: 'Epic', story: 'User story', 'business-rules': 'Business rules', 'graphql-contract': 'GraphQL contract',
  'data-dictionary': 'Data dictionary', 'source-code-references': 'Source-code references',
};
const REQUIRED_INPUTS = ['story', 'business-rules', 'data-dictionary', 'graphql-contract'];

async function run() {
  const o = await api<Overview>('/api/overview');
  const chips = (name: string, values: string[], labels: Record<string, string> = {}, required: string[] = []) => `<div class="chips">${values.map((v) => `<label class="chip"><input type="checkbox" name="${name}" value="${v}" checked ${required.includes(v) ? 'disabled' : ''} data-testid="${name}-${v}"/>${esc(labels[v] ?? v)}${required.includes(v) ? ' *' : ''}</label>`).join('')}</div>`;
  const hasBaseline = o.cycles.some((c) => c.baselineId);
  const open = o.cycles.filter((c) => ['interrupted', 'failed', 'waiting-approval', 'running'].includes(c.status));
  const active = open.at(-1) ? await api<Cycle>(`/api/cycles/${open.at(-1)!.id}`) : null;
  const stageStatus = (id: string) => active?.stages.find((s) => s.id === id)?.status ?? 'ready';
  view.innerHTML = `
  ${pageHeader({ icon: 'RN', color: '#0176d3', eyebrow: 'Run', title: 'Start a QE cycle' })}
  <div class="run-layout">
    <article class="card" data-testid="run"><div class="card-b">
      <div class="step"><h3><span class="step-num">1</span>Run type</h3>
        <label class="option"><input type="radio" name="mode" value="baseline" checked data-testid="mode-baseline"/><span><b>Baseline</b><small>Design everything from the recorded inputs</small></span></label>
        <label class="option"><input type="radio" name="mode" value="incremental" ${hasBaseline ? '' : 'disabled'} data-testid="mode-incremental"/><span><b>Incremental</b><small>${hasBaseline ? 'Only what changed since the last final baseline' : 'Needs an approved final baseline first'}</small></span></label>
      </div>
      <div class="step"><h3><span class="step-num">2</span>Testing types and channels</h3>${chips('type', o.options.testingTypes)}<div class="mt">${chips('channel', o.options.channels, { ui: 'UI (Playwright)', api: 'GraphQL API' })}</div></div>
      <div class="step"><h3><span class="step-num">3</span>Inputs and skills</h3>
        ${acc('Recorded inputs', chips('input', o.options.inputs, INPUT_LABELS, REQUIRED_INPUTS) + '<p class="hint">* required</p>', `${o.options.inputs.length} selected`)}
        ${acc('Skills', chips('skill', o.options.skills), `${o.options.skills.length} selected`)}
      </div>
      <div class="step"><h3><span class="step-num">4</span>Start</h3>
        <label>Requested by<input id="requestedBy" value="${esc(user())}" placeholder="Your name" data-testid="requested-by"/></label>
        <label class="inline mt"><input type="checkbox" id="fixed" data-testid="fixed-build"/> Use the fixed service build (BR-002 re-test)</label>
        <div class="row"><button class="primary" id="start" data-testid="start-cycle">Start cycle</button></div>
        <div id="run-msg"></div>
      </div>
    </div></article>
    <div class="stack">
      ${card(active ? `Agents · ${active.id}` : 'Agents and gates', `<div class="agent-grid">${o.stages.map((s, i) => {
        const st = stageStatus(s.id);
        return `<div class="agent ${s.gate ? 'gate' : ''} s-${esc(st)}"><span class="num">${i + 1}</span><div><b>${esc(s.gate ? s.name : s.agent ?? s.name)}</b><small>${esc(s.gate ? 'Human approval' : s.name)}</small>${active ? pill(st) : ''}</div></div>`;
      }).join('')}</div>`, { icon: 'AG', color: '#0176d3' })}
      ${open.length ? card('Continue a cycle', `<ul class="list">${open.map((c) => `<li><b>${esc(c.id)}</b>${pill(c.status)}<span class="grow"></span>${['interrupted', 'failed'].includes(c.status) ? `<button class="sm" data-resume="${c.id}" data-testid="resume-${c.id}">Resume</button>` : `<a href="#/review/${c.id}">Open Human Review</a>`}</li>`).join('')}</ul>`, { icon: 'CY', color: '#06a59a' }) : ''}
    </div>
  </div>`;
  const vals = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].filter((i) => i.checked).map((i) => i.value);
  document.getElementById('start')!.onclick = async () => {
    const requestedBy = (document.getElementById('requestedBy') as HTMLInputElement).value.trim();
    remember(requestedBy);
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
  'requirements-baseline': 'Decide every review finding; only accepted findings change the baseline.',
  'test-design': 'Review the business rules, test cases and coverage.',
  execution: 'Allow the generated automation to run against the local demo service.',
  release: 'Sign off the final baseline and the rules-based recommendation.',
};

function reviewContent(b: Bundle, g: string) {
  const id = b.cycle.id;
  if (g === 'requirements-baseline') {
    return card(`Review Agent findings`, `<p class="hint">Advisory only: the agent never approves or edits requirements.</p>
      ${b.findings.map((f) => `<div class="finding ${esc(f.severity)}" data-testid="finding" data-finding="${f.id}">
        <div class="finding-h">${pill(f.severity === 'high' ? 'failed' : f.severity === 'medium' ? 'pending' : 'info', f.severity)}<span class="badge">${esc(f.type)}</span><b>${f.id} · ${esc(f.title)}</b></div>
        <p>${esc(f.recommendation)}</p>
        <details class="inline"><summary>Details and evidence</summary><p>${esc(f.detail)}</p><div class="small">${f.evidence.map((e) => `“${esc(e.quote)}” — ${esc(e.source)}`).join('<br/>')}</div></details>
        <div class="row"><label>Decision<select data-decision="${f.id}" data-testid="decision-${f.id}"><option value="">Choose…</option><option value="accept">Accept</option><option value="reject">Reject</option><option value="defer">Defer</option></select></label>
        <label style="flex:1">Comment<input data-comment="${f.id}" data-testid="comment-${f.id}" placeholder="Optional"/></label></div></div>`).join('')}
      ${acc('Draft requirements', table(['ID', 'Kind', 'Source', 'Text'], b.requirements.map((r) => [r.id, esc(r.kind), esc(r.sourceId), esc(r.text)]), 'requirements-table'), `${b.requirements.length}`)}`, { icon: 'RV', color: COLORS.requirement });
  }
  if (g === 'test-design') {
    const byType = b.testCases.reduce<Record<string, number>>((a, t) => ((a[t.type] = (a[t.type] ?? 0) + 1), a), {});
    return `<div class="stats">${stat('Business rules', String(b.rules.length))}${stat('Test cases', String(b.testCases.length))}${Object.entries(byType).map(([k, v]) => stat(k, String(v))).join('')}</div>
      ${card('Business rules', table(['Rule', 'Condition', 'Expected outcome', 'Source'], b.rules.map((r) => [`<b>${r.id}</b>`, esc(r.condition), esc(r.expectedOutcome), r.sourceRequirements.join(', ')]), 'rules-table'), { icon: 'BR', color: COLORS.rule })}
      ${acc('Generated test cases', table(['ID', 'Type', 'Channel', 'Priority', 'Title', 'Rules'], b.testCases.map((t) => [t.id, t.type, t.channel, t.priority, esc(t.title), t.ruleIds.join(', ')]), 'testcase-table'), `${b.testCases.length}`)}
      ${acc('Coverage matrix', coverageTable(b), `${b.coverage.length} requirements`)}
      ${b.excluded.length ? `<p class="hint">Excluded by selection: ${b.excluded.map((e) => esc(`${e.title} (${e.reason})`)).join('; ')}</p>` : ''}`;
  }
  if (g === 'execution') {
    const valid = b.datasets.filter((d) => d.validation.status === 'valid').length;
    return `<div class="stats">${stat('Playwright specs', String(b.scripts.length))}${stat('UI / API', `${b.scripts.filter((s) => s.channel === 'ui').length} / ${b.scripts.filter((s) => s.channel === 'api').length}`)}${stat('Datasets valid', `${valid}/${b.datasets.length}`, { tone: valid === b.datasets.length ? 'ok' : 'bad' })}</div>
      <div class="notice">Execution starts the demo service on 127.0.0.1 and runs Playwright with traces on. Nothing leaves this machine.</div>
      ${acc('Generated automation', table(['Script', 'Channel', 'Test case', 'Dataset', 'Validation'], b.scripts.map((s) => [art(s.file, s.id), s.channel, s.testCaseId, s.datasetId, pill(b.datasets.find((d) => d.id === s.datasetId)?.validation.status ?? '?')]), 'script-table'), `${b.scripts.length}`)}`;
  }
  const m = b.metrics!;
  return `<div class="decision-banner ${decisionTone(m.recommendation.decision)}"><div><span class="lbl">Rules-based recommendation</span><span class="decision" data-testid="gate-recommendation">${esc(m.recommendation.decision)}</span></div><div class="reason">${esc(m.recommendation.reason)}</div></div>
    ${card('Release policy', policyTable(m), { icon: 'RP', color: COLORS.report, actions: `<a href="#/reporting/${id}">Full report</a>` })}`;
}

async function review(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  const c = b.cycle;
  const gate = c.stages.find((s) => s.status === 'waiting-approval');
  const history = c.approvals.length ? `<ul class="list" data-testid="approval-history">${c.approvals.map((a) => `<li>${pill(a.decision)}<div class="grow"><b>${esc(a.gate)}</b><small>${esc(a.approver)} · ${time(a.timestamp)}${a.comments ? ` · ${esc(a.comments)}` : ''}</small></div></li>`).join('')}</ul>` : '<p class="hint" data-testid="approval-history">No decisions yet.</p>';
  const header = pageHeader({ icon: 'HR', color: COLORS.gate, eyebrow: 'Human Review', title: `${esc(id)} ${pill(c.status)}`, fields: [['Requested by', esc(c.config.requestedBy)], ['Mode', esc(c.config.mode)], ['Gates approved', `${gatesApproved(c)} / 4`]] });
  let body = '';
  if (!gate) {
    body = c.status === 'running'
      ? `<div class="notice" data-testid="agents-working">Agents are working on “${esc(c.stages.find((s) => s.status === 'running')?.name ?? '')}”. This page refreshes automatically.</div>`
      : `<div class="notice ${c.status === 'completed' ? 'ok' : 'warn'}" data-testid="no-gate">No decision pending. Cycle status: ${esc(c.status)}. <a href="#/reporting/${id}">Open reporting</a></div>`;
    view.innerHTML = `<div data-testid="review">${header}${cyclePath(c)}${body}${card('Approval history', history, { icon: 'AH', color: COLORS.audit })}</div>`;
    watchCycle(c);
    return;
  }
  const g = gate.gate!;
  view.innerHTML = `<div data-testid="review">${header}${cyclePath(c)}
    <div class="notice warn" data-testid="gate-blocked"><span class="ico">⛔</span><div><b>${esc(gate.name)}</b> — processing is blocked until a human decision is recorded. ${esc(GATE_TEXT[g])}</div></div>
    <div class="split"><div>${reviewContent(b, g)}</div>
    <aside>${card('Your decision', `<label>Approver (human name)<input id="approver" class="field-full" value="${esc(user())}" data-testid="approver"/></label>
        <label class="mt">Comments<textarea id="comments" data-testid="comments" placeholder="Required when rejecting"></textarea></label>
        <div class="row"><button class="primary" id="approve" data-testid="approve">Approve</button><button class="danger" id="reject" data-testid="reject">Reject</button></div>
        <div id="gate-msg"></div>`, { icon: 'OK', color: COLORS.gate })}
      ${card('Approval history', history, { icon: 'AH', color: COLORS.audit })}</aside></div></div>`;
  const approveBtn = document.getElementById('approve') as HTMLButtonElement;
  const decisions = () => b.findings.map((f) => ({ findingId: f.id, decision: (document.querySelector(`[data-decision="${f.id}"]`) as HTMLSelectElement).value, comment: (document.querySelector(`[data-comment="${f.id}"]`) as HTMLInputElement).value }));
  const sync = () => {
    const pending = g === 'requirements-baseline' ? decisions().filter((d) => !d.decision).length : 0;
    approveBtn.disabled = pending > 0;
    approveBtn.title = pending ? `${pending} finding(s) still need a decision` : '';
  };
  document.querySelectorAll('[data-decision]').forEach((el) => el.addEventListener('change', sync));
  sync();
  const submit = async (decision: 'approved' | 'rejected') => {
    const approver = (document.getElementById('approver') as HTMLInputElement).value.trim();
    remember(approver);
    try {
      await api(`/api/cycles/${id}/approvals`, { method: 'POST', json: { gate: g, approver, decision, comments: (document.getElementById('comments') as HTMLTextAreaElement).value, findingDecisions: g === 'requirements-baseline' ? decisions() : undefined } });
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
  return table(['Requirement', 'Rules', 'Smoke', 'Pos', 'Neg', 'Bnd', 'E2E', 'Coverage'], b.coverage.map((r) => [trace(b.cycle.id, r.requirementId, r.requirementId, 'requirement'), r.ruleIds.join(' '), ...['smoke', 'positive', 'negative', 'boundary', 'e2e'].map((t) => String(r.byType[t] ?? 0)), pill(r.coverage.startsWith('not') ? 'untested' : r.coverage === 'covered' ? 'covered' : 'partial', r.coverage)]), 'coverage-matrix');
}

function policyTable(m: Metrics) {
  return table(['Rule', 'Release policy', 'Result', 'If failed'], m.recommendation.policy.map((p) => [`<b>${p.id}</b>`, `${esc(p.description)}<br/><small>${esc(p.detail)}</small>`, pill(p.passed ? 'pass' : 'FAIL'), esc(p.outcomeIfFailed)]), 'policy-table');
}

// ---------- Cycle Details ----------
function outputs(s: StageState) {
  if (!s.outputs.length) return '<span class="muted">—</span>';
  const first = s.outputs.slice(0, 2).map((o) => art(o.path, o.label)).join('<br/>');
  return s.outputs.length > 2 ? `${first}<details class="inline"><summary>+${s.outputs.length - 2} more</summary>${s.outputs.slice(2).map((o) => art(o.path, o.label)).join('<br/>')}</details>` : first;
}

async function cycleDetails(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  const c = b.cycle;
  view.innerHTML = `<div data-testid="cycle-details">
    ${pageHeader({ icon: 'CY', color: COLORS.execution, eyebrow: 'Cycle', title: `${esc(c.id)} ${pill(c.status)}`, fields: [['Mode', esc(c.config.mode)], ['Build', esc(c.demoServiceBuild ?? 'not executed')], ['Requested by', esc(c.config.requestedBy)], ['Final baseline', esc(c.baselineId ?? '—')], ['Created', time(c.createdAt)]],
      actions: `<a class="btn" href="#/execution/${id}">Execution</a><a class="btn primary" href="#/reporting/${id}">Reporting</a>` })}
    ${cyclePath(c)}
    ${['interrupted', 'failed'].includes(c.status) ? `<div class="notice warn">This cycle was ${c.status}; completed stages are kept. <button class="sm" id="resume" data-testid="resume">Resume cycle</button></div>` : ''}
    ${c.status === 'waiting-approval' ? `<div class="notice warn">Waiting for a human decision. <a href="#/review/${id}">Open Human Review</a></div>` : ''}
    ${card('Stages', table(['#', 'Stage', 'Owner', 'Status', 'Summary', 'Artifacts'], c.stages.map((s, i) => [String(i + 1), `<b>${esc(s.name)}</b>${s.finishedAt ? `<br/><small>${time(s.finishedAt)}</small>` : ''}`, s.agent ? esc(s.agent) : '<span class="badge b-warning">Human gate</span>', pill(s.status), `<small>${esc(s.error ?? s.summary ?? '')}</small>`, outputs(s)]), 'stage-table'), { icon: 'ST', color: '#0176d3' })}
    ${acc('Approvals', table(['Gate', 'Decision', 'Approver', 'When', 'Comments'], c.approvals.map((a) => [esc(a.gate), pill(a.decision), esc(a.approver), time(a.timestamp), esc(a.comments)])), `${c.approvals.length}`)}
    ${acc('Requirements baseline', table(['Req', 'Kind', 'Status', 'Text'], b.requirements.map((r) => [trace(id, r.id, r.id, 'requirement'), esc(r.kind), pill(r.status), esc(r.text)]), 'baseline-table'), `${b.requirements.length}`)}
    ${acc('Business-rules catalogue', table(['Rule', 'Text', 'Error code', 'Source'], b.rules.map((r) => [trace(id, r.id, r.id, 'rule'), esc(r.text), esc(r.check.errorCode ?? ''), r.sourceRequirements.map((q) => trace(id, q, q, 'requirement')).join(' ')]), 'rules-catalogue'), `${b.rules.length}`)}
    ${acc('Inputs and provenance', table(['Input', 'File', 'sha256', 'Recorded from'], b.manifest.map((d) => [esc(INPUT_LABELS[d.key] ?? d.key), esc(d.file), `<code>${esc(d.sha256.slice(0, 12))}</code>`, esc(d.recordedFrom)])), `${b.manifest.length}`)}
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
  const valid = b.datasets.filter((d) => d.validation.status === 'valid').length;
  view.innerHTML = `<div data-testid="test-data">
    ${pageHeader({ icon: 'TD', color: COLORS.dataset, eyebrow: `Test Data · ${id}`, title: `Synthetic datasets ${synthetic()}`, fields: [['Datasets', String(b.datasets.length)], ['Valid', `${valid}/${b.datasets.length}`], ['Dictionary', esc(b.datasets[0] ? `v${b.datasets[0].provenance.dictionaryVersion}` : '—')], ['Masking', 'On']] })}
    ${b.datasets.length ? card('One dataset per test case', table(['Dataset', 'Class', 'Test case', 'Version', 'Validation', 'Intentional violation', 'Values'], b.datasets.map((d) => [trace(id, d.id, d.id, 'dataset'), `<span class="badge synthetic" data-testid="classification">${d.classification}</span>`, trace(id, d.testCaseId, d.testCaseId, 'test-case'), `v${d.version}`, `${pill(d.validation.status)}<br/><small>${d.validation.checks.length + d.validation.privacy.length} checks</small>`, esc(d.intentionalViolations.join(', ') || '—'), `<details class="inline"><summary>View</summary><pre>${esc(JSON.stringify(d.values, null, 1))}</pre><small>${esc(d.provenance.generator)} · seed ${esc(d.provenance.seed)}</small></details>`]), 'dataset-table'), { icon: 'DS', color: COLORS.dataset }) : '<div class="notice">Datasets are generated after Gate 2 (test design) is approved.</div>'}
    ${card('Provenance check', `<p class="hint">Datasets with unknown provenance are rejected.</p><div class="row"><button id="probe" data-testid="probe-provenance">Submit a dataset with unknown provenance</button><span id="probe-result" data-testid="probe-result"></span></div>`, { icon: 'PV', color: COLORS.audit })}
  </div>`;
  document.getElementById('probe')!.onclick = async () => {
    const res = await fetch('/api/datasets/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'DS-UNKNOWN', classification: 'SYNTHETIC', provenance: { generator: 'unknown-export.csv' }, values: {} }) });
    const body = await res.json();
    document.getElementById('probe-result')!.innerHTML = `${pill(body.accepted ? 'pass' : 'rejected')} ${esc(body.reason ?? '')}`;
  };
}

// ---------- Execution ----------
function evidenceLinks(r: ExecResult) {
  return r.evidence.map((e) => art(e.path, e.kind)).join(' · ');
}

async function execution(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  const ex = b.execution;
  const tcTitle = (tc: string) => b.testCases.find((t) => t.id === tc)?.title ?? tc;
  const failures = ex?.results.filter((r) => r.status === 'failed') ?? [];
  view.innerHTML = `<div data-testid="execution">
    ${pageHeader({ icon: 'EX', color: COLORS.execution, eyebrow: `Execution · ${id}`, title: 'Test execution', fields: ex ? [['Build', esc(ex.demoServiceBuild)], ['Run', esc(ex.runId)], ['Started', time(ex.startedAt)], ['Reports', `${art(`cycles/${id}/execution/playwright-report.json`, 'JSON')} · ${art(`cycles/${id}/execution/playwright-output.log`, 'log')}`]] : [] })}
    ${ex ? `<div class="stats">${stat('Executed', String(ex.totals.total))}${stat('Passed', String(ex.totals.passed), { tone: 'ok', testid: 'passed-count' })}${stat('Failed', String(ex.totals.failed), { tone: ex.totals.failed ? 'bad' : 'ok', testid: 'failed-count' })}${stat('Duration', `${Math.round(ex.durationMs / 1000)} s`)}</div>
      ${failures.length ? card(`Failures (${failures.length})`, failures.map((r) => {
        const shot = r.evidence.find((e) => e.kind === 'screenshot');
        return `<div class="failure">${shot ? `<a href="/artifacts/${encodeURI(shot.path)}" target="_blank"><img class="shot" src="/artifacts/${encodeURI(shot.path)}" alt="${esc(shot.label)}" data-testid="screenshot"/></a>` : '<div class="muted">No screenshot (API test)</div>'}
          <div><b>${trace(id, r.testCaseId, r.testCaseId, 'test-case')} · ${esc(tcTitle(r.testCaseId))}</b><pre>${esc(r.error?.message.split('\n').slice(0, 4).join('\n') ?? '')}</pre><small>${trace(id, r.id, r.id, 'execution')} · ${evidenceLinks(r)}</small></div></div>`;
      }).join(''), { icon: '!', color: COLORS.defect }) : '<div class="notice ok">All executed tests passed.</div>'}
      ${card('Results', table(['Execution', 'Test case', 'Channel', 'Status', 'ms', 'Evidence'], ex.results.map((r) => [trace(id, r.id, r.id, 'execution'), `${trace(id, r.testCaseId, r.testCaseId, 'test-case')} <small>${esc(tcTitle(r.testCaseId))}</small>`, esc(b.scripts.find((s) => s.id === r.scriptId)?.channel ?? ''), pill(r.status), String(r.durationMs), `<small>${evidenceLinks(r)}</small>`]), 'results-table'), { icon: 'RS', color: COLORS.execution })}`
    : `<div class="notice">Not executed yet. ${b.scripts.length ? `${b.scripts.length} scripts are waiting for Gate 3. <a href="#/review/${id}">Approve execution</a>` : ''}</div>`}
    ${card('Defects', defectCards(b), { icon: 'DF', color: COLORS.defect })}
    ${acc('Generated scripts', table(['Script', 'Channel', 'Test case', 'Dataset', 'Rules'], b.scripts.map((s) => [art(s.file, s.id), s.channel, s.testCaseId, s.datasetId, s.ruleIds.join(' ')])) + (b.scripts.length ? `<p class="hint">Shared utilities: ${art(`cycles/${id}/automation/support/aqe.ts`, 'support/aqe.ts')} · ${art(`cycles/${id}/automation/support/reservation-console.ts`, 'support/reservation-console.ts')} · ${art(`cycles/${id}/automation/playwright.config.ts`, 'playwright.config.ts')}</p>` : ''), `${b.scripts.length}`)}
  </div>`;
  watchCycle(b.cycle);
}

function defectCards(b: Bundle) {
  const id = b.cycle.id;
  if (!b.defects.length) return '<p class="hint">No defects. Defects are created only from failed executions.</p>';
  return b.defects.map((d) => `<div class="defect" data-testid="defect" data-defect="${d.id}">
    <div class="defect-h"><h3>${trace(id, d.id, d.id, 'defect')}</h3>${pill('failed', d.severity)}${d.blocksRelease ? pill('blocked', 'blocks release') : ''}<b>${esc(d.title)}</b></div>
    <div class="kv"><div><span>Expected</span>${esc(d.expected)}</div><div><span>Actual</span><div data-testid="defect-actual">${esc(d.actual)}</div></div>
      <div><span>Suspected cause</span>${esc(d.suspectedCause)}</div><div><span>Suggested remediation</span>${esc(d.suggestedRemediation)}</div></div>
    ${acc('Impact, traceability and evidence', `<p>${esc(d.impact)}</p><div class="chain">${[...d.requirementIds.map((r) => trace(id, r, r, 'requirement')), trace(id, d.ruleId, d.ruleId, 'rule'), ...d.testCaseIds.map((t) => trace(id, t, t, 'test-case')), ...d.executionIds.map((x) => trace(id, x, x, 'execution')), ...d.evidenceIds.map((e) => trace(id, e, e, 'evidence'))].join(' ')}</div>
      ${d.codeReference ? `<pre>// ${esc(d.codeReference.file)}:${d.codeReference.line}\n${esc(d.codeReference.excerpt.join('\n'))}</pre>` : ''}`)}
  </div>`).join('');
}

// ---------- Reporting ----------
const REPORTS: [string, string][] = [
  ['qe-lead-report.html', 'QE lead report'], ['executive-dashboard.html', 'Executive dashboard'], ['release-readiness.md', 'Release readiness'], ['cycle-report.md', 'Cycle report'],
  ['coverage-report.md', 'Coverage report'], ['execution-summary.md', 'Execution summary'], ['defect-report.md', 'Defect report'], ['qe-lead-report.md', 'QE lead report (Markdown)'], ['metrics.json', 'Metrics (JSON)'],
];

async function reporting(id: string | null) {
  if (!id) return (view.innerHTML = noCycle());
  const b = await api<Bundle>(`/api/cycles/${id}/bundle`);
  const m = b.metrics;
  const header = pageHeader({ icon: 'RP', color: COLORS.report, eyebrow: `Reporting · ${id}`, title: 'Release readiness', fields: [['Build', esc(b.cycle.demoServiceBuild ?? '—')], ['Final baseline', esc(b.cycle.baselineId ?? 'pending Gate 4')], ['Requested by', esc(b.cycle.config.requestedBy)]],
    actions: `<a class="btn" href="/api/cycles/${id}/export.json" data-testid="export-json">Export JSON</a><a class="btn" href="/api/cycles/${id}/export.xlsx" data-testid="export-xlsx">Export Excel</a>` });
  if (!m) return (view.innerHTML = `<div data-testid="reporting">${header}<div class="notice">Reports are produced after execution. Current status: ${pill(b.cycle.status)}</div></div>`);
  const d = m.recommendation.decision;
  view.innerHTML = `<div data-testid="reporting">${header}
    <div class="decision-banner ${decisionTone(d)}"><div><span class="lbl">Rules-based recommendation</span><span class="decision" data-testid="recommendation">${esc(d)}</span></div><div class="reason">${esc(m.recommendation.reason)}${m.recommendation.conditions.length ? `<ul>${m.recommendation.conditions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div></div>
    <div class="stats">
      ${stat('Pass rate', `${m.execution.passRate}%`, { testid: 'pass-rate', tone: m.execution.failed ? 'bad' : 'ok', sub: `${m.execution.passed}/${m.execution.total} passed` })}
      ${stat('Defects', String(m.defects.total), { testid: 'defect-count', tone: m.defects.total ? 'bad' : 'ok', sub: `${m.defects.blocking} release-blocking` })}
      ${stat('Requirements covered', `${m.requirements.covered}/${m.requirements.active}`)}
      ${stat('Rules verified', `${m.rules.verified}/${m.rules.total}`, { tone: m.rules.failing ? 'bad' : '' })}
    </div>
    <div class="grid-2">
      ${card('Release policy', policyTable(m), { icon: 'RP', color: COLORS.report })}
      <div class="stack">
        ${card('Reports', `<ul class="list cols">${REPORTS.map(([f, label]) => `<li>${art(`cycles/${id}/reports/${f}`, label)}</li>`).join('')}<li><small>Traceability node</small> ${trace(id, b.reportId, b.reportId, 'report')}</li></ul>`, { icon: 'RE', color: '#2ecbbe' })}
        ${card('Approvals', `<ul class="list" data-testid="report-approvals">${m.approvals.map((a) => `<li>${pill(a.status)}<div class="grow"><b>${esc(a.gate)}</b><small>${esc(a.approver ?? 'awaiting decision')}${a.timestamp ? ` · ${time(a.timestamp)}` : ''}</small></div></li>`).join('')}</ul>`, { icon: 'AP', color: COLORS.gate })}
        ${card('Privacy and security', `<ul class="list" data-testid="privacy-table">${m.privacy.checks.map((p) => `<li>${pill(p.passed ? 'pass' : 'FAIL')}<div class="grow">${esc(p.name)}<small>${esc(p.detail)}</small></div></li>`).join('')}</ul>`, { icon: 'PR', color: COLORS.rule })}
      </div>
    </div>
    <div class="mt">${card('Defects', defectCards(b), { icon: 'DF', color: COLORS.defect })}</div>
    ${m.risks.length ? card('Risks and gaps', `<ul>${m.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`, { icon: 'RK', color: '#fe9339' }) : ''}
    ${card('Traceability search', `<div class="row"><input id="q" placeholder="Search e.g. BR-002, TC-004, DEF-001, customerCount" style="flex:1" data-testid="trace-search"/><button id="go" class="primary">Search</button></div><div id="trace-rows"><p class="hint">Search any ID or field to see its lineage from requirement to report.</p></div>`, { icon: 'TR', color: COLORS.report })}
    ${acc('Coverage matrix and rule verification', coverageTable(b) + '<div class="mt"></div>' + table(['Rule', 'Tests', 'Passed', 'Failed', 'Status'], m.rules.byRule.map((r) => [trace(id, r.id, r.id, 'rule'), String(r.tests), String(r.passed), String(r.failed), pill(r.status)])), `${m.rules.total} rules`)}
  </div>`;
  const search = async () => {
    const q = (document.getElementById('q') as HTMLInputElement).value.trim();
    if (!q) return void (document.getElementById('trace-rows')!.innerHTML = '<p class="hint">Search any ID or field to see its lineage from requirement to report.</p>');
    const { rows } = await api<{ rows: Record<string, string>[] }>(`/api/cycles/${id}/trace?q=${encodeURIComponent(q)}`);
    const t = (v: string, type: string) => (v ? v.split(' ').map((x) => trace(id, x, x, type)).join(' ') : '');
    document.getElementById('trace-rows')!.innerHTML = table(['Requirement', 'Rule', 'Test case', 'Dataset', 'Script', 'Execution', 'Status', 'Defect'], rows.map((r) => [t(r.requirementId, 'requirement'), t(r.ruleId, 'rule'), t(r.testCaseId, 'test-case'), t(r.datasetId, 'dataset'), t(r.scriptId, 'script'), t(r.executionId, 'execution'), pill(r.status), t(r.defectIds, 'defect')]), 'trace-table');
  };
  const q = document.getElementById('q') as HTMLInputElement;
  document.getElementById('go')!.onclick = search;
  q.oninput = () => void search();
  q.onkeydown = (e) => { if (e.key === 'Enter') void search(); };
}

// ---------- Trace node ----------
async function traceNode(cycleId: string, nodeId: string) {
  const r = await api<{ node: TraceNode; data: unknown; up: TraceNode[]; down: TraceNode[]; lineage: TraceNode[] }>(`/api/cycles/${cycleId}/trace/${encodeURIComponent(nodeId)}`);
  const chip = (n: TraceNode) => trace(cycleId, n.id, `${n.type}: ${n.id}`, n.type);
  const order = ['report', 'defect', 'evidence', 'execution', 'script', 'dataset', 'test-case', 'rule', 'requirement'];
  const lineage = [...r.lineage].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const shot = r.node.type === 'evidence' && r.node.path?.endsWith('.png') ? `<img class="shot" src="/artifacts/${encodeURI(r.node.path)}" alt="screenshot"/>` : '';
  view.innerHTML = `<div data-testid="trace-node" data-node-type="${esc(r.node.type)}" data-node-id="${esc(r.node.id)}">
    ${pageHeader({ icon: r.node.type.slice(0, 2).toUpperCase(), color: COLORS[r.node.type] ?? '#0176d3', eyebrow: `Traceability · ${r.node.type}`, title: esc(r.node.id), fields: [['Label', esc(r.node.label)], ...(r.node.path ? [['Artifact', art(r.node.path)] as [string, string]] : [])], actions: `<a class="btn" href="#/reporting/${cycleId}">Back to Reporting</a>` })}
    ${card('Lineage back to the requirement', `<div class="chain" data-testid="trace-lineage">${lineage.map(chip).join('<span class="arrow">‹</span>') || '<span class="muted">none (origin)</span>'}</div>${shot ? `<div class="mt">${shot}</div>` : ''}`, { icon: 'LN', color: COLORS.report })}
    <div class="grid-2">
      ${card('Linked from', `<div class="chain" data-testid="trace-up">${r.up.map(chip).join(' ') || '<span class="muted">—</span>'}</div>`)}
      ${card('Links to', `<div class="chain" data-testid="trace-down">${r.down.map(chip).join(' ') || '<span class="muted">—</span>'}</div>`)}
    </div>
    ${acc('Record', `<pre>${esc(JSON.stringify(r.data, null, 2))}</pre>`)}
  </div>`;
}

// ---------- Test Lab ----------
const EXAMPLES: { title: string; hint: string; text: string }[] = [
  { title: 'Defect path', hint: 'Customer count 0 (BR-002) — the seeded build accepts it', text: 'A reservation with customer count 0 should be rejected' },
  { title: 'Happy path in the console', hint: 'UI test that expects a confirmation number', text: 'In the console, a reservation for 3 customers should be confirmed' },
  { title: 'Date order', hint: 'End date before start date (BR-001)', text: 'A reservation whose end date is before the start date should be rejected' },
  { title: 'Missing customer field', hint: 'No email supplied (BR-006)', text: 'A reservation without an email should be rejected' },
  { title: 'Payment rejection', hint: 'Unapproved payment method (BR-004)', text: 'Payment method CASH should be rejected' },
];
const LAB_AGENTS = ['Test Design Agent', 'Test Data Agent', 'Automation Agent', 'Execution Agent', 'Defect Intelligence Agent'];

function labAgents(r: LabRun | null, running = false) {
  const state = (i: number): [string, string] => {
    if (running) return ['running', 'working'];
    if (!r) return ['pending', 'waiting'];
    if (i === 0) return ['done', r.testCase.id];
    if (i === 1) return [r.dataset.validation.status === 'valid' ? 'done' : 'failed', r.dataset.id];
    if (i === 2) return r.script ? ['done', r.script.id] : ['blocked', 'not generated'];
    if (i === 3) return r.execution ? [r.execution.status === 'passed' ? 'done' : 'failed', `test ${r.execution.status}`] : ['blocked', 'not run'];
    return r.defects.length ? ['failed', r.defects.map((d) => d.id).join(', ')] : ['done', 'no defect'];
  };
  return `<div class="agent-grid">${LAB_AGENTS.map((a, i) => { const [s, label] = state(i); return `<div class="agent s-${s === 'done' ? 'completed' : s}"><span class="num">${i + 1}</span><div><b>${esc(a)}</b>${pill(s, label)}</div></div>`; }).join('')}</div>`;
}

function labResult(r: LabRun) {
  const chain = r.chain.map((l) => `<span class="node t-${esc(l.type)}" data-testid="chain-${esc(l.type)}">${l.path ? `<a href="/artifacts/${encodeURI(l.path)}" target="_blank">${esc(l.id)}</a>` : esc(l.id)} <small>${esc(l.type)}</small></span>`).join('<span class="arrow">›</span>');
  const shot = r.execution?.evidence.find((e) => e.kind === 'screenshot');
  const passed = r.execution?.status === 'passed';
  return `<div data-testid="lab-result" data-status="${esc(r.status)}">
    <div class="notice ${r.blockedReason ? 'warn' : passed ? 'ok' : 'error'}"><div><b>${esc(r.id)} · ${r.blockedReason ? 'Blocked' : passed ? 'Behaves as expected' : 'Defect found'}</b><br/><small>“${esc(r.scenario)}”</small>${r.blockedReason ? `<br/>${esc(r.blockedReason)}` : ''}</div></div>
    <div class="compare"><div><span>Expected</span><b>${esc(r.interpretation.expectation)}</b><small> by ${esc(r.interpretation.ruleId)}</small></div><div class="${passed ? 'ok' : 'bad'}"><span>Test result</span><b>${esc(r.execution?.status ?? r.status)}</b>${r.execution ? `<small> ${r.execution.durationMs} ms</small>` : ''}</div></div>
    <h3 class="section-title">Traceability chain</h3><div class="chain" data-testid="lab-chain">${chain}</div>
    ${r.defects.map((d) => `<div class="defect mt"><div class="defect-h"><b>${esc(d.id)}</b>${pill('failed', d.severity)}${esc(d.title)}</div><small>${esc(d.suspectedCause)}</small></div>`).join('')}
    ${acc('Generated test case, data and script', `<ul class="list"><li><b>Test case</b><span class="grow">${esc(r.testCase.id)} [${esc(r.testCase.type)}/${esc(r.testCase.channel)}] ${esc(r.testCase.title)}</span></li>
      <li><b>Dataset</b><span class="grow">${synthetic()} ${esc(r.dataset.id)} ${pill(r.dataset.validation.status)}<pre>${esc(JSON.stringify(r.dataset.values))}</pre></span></li>
      <li><b>Script</b><span class="grow">${r.script ? art(r.script.file, r.script.id) : '—'}</span></li>
      <li><b>Interpretation</b><span class="grow">channel ${esc(r.interpretation.channel)} · mutation <code>${esc(JSON.stringify(r.interpretation.mutation))}</code> · expectation from ${esc(r.interpretation.expectationSource)}${r.interpretation.notes.map((n) => `<br/><small>${esc(n)}</small>`).join('')}</span></li></ul>
      ${r.execution?.error ? `<pre>${esc(r.execution.error.message.split('\n').slice(0, 5).join('\n'))}</pre>` : ''}${shot ? `<img class="shot" src="/artifacts/${encodeURI(shot.path)}" alt="screenshot"/>` : ''}
      <p class="hint">Rules from ${esc(r.rulesFrom)} · approved by ${esc(r.approvedBy)} · ${time(r.createdAt)}</p>`)}
  </div>`;
}

async function lab() {
  const runs = await api<LabRun[]>('/api/lab');
  view.innerHTML = `${pageHeader({ icon: 'TL', color: COLORS.lab, eyebrow: 'Test Lab', title: 'Try a single scenario' })}
  <div class="run-layout">
    <article class="card" data-testid="lab"><div class="card-b">
      <div class="step"><h3><span class="step-num">1</span>Pick an example</h3>${EXAMPLES.map((e, i) => `<label class="option"><input type="radio" name="example" data-example="${i}"/><span><b>${esc(e.title)}</b><small>${esc(e.hint)}</small></span></label>`).join('')}</div>
      <div class="step"><h3><span class="step-num">2</span>Describe the test</h3><textarea id="scenario" data-testid="lab-scenario" placeholder="e.g. A reservation with customer count 0 should be rejected"></textarea></div>
      <div class="step"><h3><span class="step-num">3</span>Approve and run</h3>
        <label>Approver (human name)<input id="lab-approver" value="${esc(user())}" data-testid="lab-approver"/></label>
        <div class="row"><button class="primary" id="lab-run" data-testid="lab-run">Generate, approve and execute</button></div><div id="lab-msg"></div></div>
    </div></article>
    <div class="stack">
      ${card('Agents', `<div id="lab-agents">${labAgents(null)}</div>`, { icon: 'AG', color: '#0176d3' })}
      <div id="lab-out"></div>
      ${runs.length ? acc('Previous lab runs', table(['Run', 'Scenario', 'Status', 'Rule', 'When'], runs.slice().reverse().slice(0, 15).map((r) => [esc(r.id), esc(r.scenario), pill(r.status), esc(r.interpretation.ruleId), time(r.createdAt)])), `${runs.length}`) : ''}
    </div>
  </div>`;
  const scenario = document.getElementById('scenario') as HTMLTextAreaElement;
  document.querySelectorAll<HTMLInputElement>('[data-example]').forEach((b) => (b.onchange = () => (scenario.value = EXAMPLES[Number(b.dataset.example)].text)));
  document.getElementById('lab-run')!.onclick = async () => {
    const btn = document.getElementById('lab-run') as HTMLButtonElement;
    const approver = (document.getElementById('lab-approver') as HTMLInputElement).value.trim();
    remember(approver);
    btn.disabled = true;
    document.getElementById('lab-agents')!.innerHTML = labAgents(null, true);
    document.getElementById('lab-msg')!.innerHTML = '<div class="notice" data-testid="lab-running">Generating and executing…</div>';
    try {
      const r = await api<LabRun>('/api/lab', { method: 'POST', json: { scenario: scenario.value, approver } });
      document.getElementById('lab-msg')!.innerHTML = '';
      document.getElementById('lab-agents')!.innerHTML = labAgents(r);
      document.getElementById('lab-out')!.innerHTML = card('Result', labResult(r), { icon: 'RS', color: COLORS.lab });
    } catch (e) {
      document.getElementById('lab-agents')!.innerHTML = labAgents(null);
      document.getElementById('lab-msg')!.innerHTML = `<div class="notice error" data-testid="lab-error">${esc((e as Error).message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- Audit ----------
async function audit() {
  const entries = await api<{ seq: number; at: string; actor: string; actorType: string; action: string; target: string; details: unknown }[]>('/api/audit');
  const actions = [...new Set(entries.map((e) => e.action))].sort();
  const rows = (filter: string) => table(['#', 'When', 'Actor', 'Action', 'Target', 'Details'], entries.slice().reverse().filter((e) => !filter || e.action === filter).slice(0, 300).map((e) => [String(e.seq), time(e.at), `${esc(e.actor)} <small>${esc(e.actorType)}</small>`, pill(e.action === 'approval' ? 'approved' : 'info', e.action), esc(e.target), `<small>${esc(JSON.stringify(e.details).slice(0, 160))}</small>`]), 'audit-table');
  view.innerHTML = `<div data-testid="audit">
    ${pageHeader({ icon: 'AU', color: COLORS.audit, eyebrow: 'Audit Log', title: 'Approvals, executions, access and data actions', fields: [['Entries', String(entries.length)], ['Storage', 'Append-only JSONL, masked']], actions: '<button id="retention" data-testid="apply-retention">Apply evidence retention</button>' })}
    ${card('Entries', `<div class="row"><label>Action<select id="action-filter"><option value="">All actions</option>${actions.map((a) => `<option>${esc(a)}</option>`).join('')}</select></label></div><div id="audit-rows">${rows('')}</div>`, { icon: 'AU', color: COLORS.audit })}
  </div>`;
  const filter = document.getElementById('action-filter') as HTMLSelectElement;
  filter.onchange = () => (document.getElementById('audit-rows')!.innerHTML = rows(filter.value));
  document.getElementById('retention')!.onclick = async () => {
    await api('/api/retention/apply', { method: 'POST', json: {} });
    await audit();
  };
}

// ---------- Router ----------
async function route() {
  window.clearTimeout(pollTimer);
  setAvatar();
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
      default: view.innerHTML = '<div class="notice">Not found</div>';
    }
  } catch (e) {
    view.innerHTML = `<div class="notice error" data-testid="view-error">${esc((e as Error).message)}</div>`;
  }
}

window.addEventListener('hashchange', () => void route());
refreshCycles().then(route).then(() => document.body.setAttribute('data-ready', 'true'));
