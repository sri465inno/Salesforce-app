/**
 * Execution Agent: starts the local demo service, runs the generated Playwright suite through
 * the Playwright CLI, and captures evidence (screenshots, traces, masked request/response
 * pairs, service logs, errors, timings) for every test case.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { maskText } from '../../shared/mask';
import { ROOT, rel } from '../../shared/paths';
import { startDemoService } from '../../demo-service/app';
import { AutomationScript, EvidenceItem, ExecutionResult, ExecutionSummary } from '../types';

export const AGENT = 'Execution Agent';

interface PwAttachment { name: string; contentType: string; path?: string; body?: string }
interface PwResult { status: string; duration: number; startTime: string; errors?: { message?: string }[]; error?: { message?: string }; attachments: PwAttachment[] }
interface PwSpec { title: string; tests: { results: PwResult[] }[] }
interface PwSuite { title: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwReport { suites: PwSuite[]; errors?: { message?: string }[] }

export interface RunOptions {
  automationDir: string;
  runDir: string;
  home: string;
  scripts: AutomationScript[];
  runId: string;
  fixedDefects?: string[];
  timeoutMs: number;
  evidencePrefix?: string;
}

function playwrightCli(): string {
  return path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
}

function runCli(cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [playwrightCli(), 'test', '-c', 'playwright.config.ts'], { cwd, env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

function collectSpecs(suite: PwSuite, out: PwSpec[] = []): PwSpec[] {
  for (const s of suite.specs ?? []) out.push(s);
  for (const child of suite.suites ?? []) collectSpecs(child, out);
  return out;
}

/** Pulls "Expected: x / Received: y" out of a Playwright assertion message. */
export function parseError(message: string): { message: string; expected: string | null; actual: string | null } {
  // eslint-disable-next-line no-control-regex
  const clean = message.replace(/\u001b\[[0-9;]*m/g, '');
  const expected = /Expected(?: pattern| value| string)?:\s*(.+)/.exec(clean)?.[1]?.trim() ?? null;
  const actual = /Received(?: string| value)?:\s*(.+)/.exec(clean)?.[1]?.trim() ?? null;
  return { message: maskText(clean.split('\n').slice(0, 12).join('\n')), expected: expected && maskText(expected), actual: actual && maskText(actual) };
}

export async function executeSuite(opts: RunOptions): Promise<ExecutionSummary> {
  const started = new Date();
  fs.rmSync(opts.runDir, { recursive: true, force: true });
  fs.mkdirSync(opts.runDir, { recursive: true });
  const service = await startDemoService(0, { fixedDefects: opts.fixedDefects ?? [] });
  let cli: { code: number; output: string };
  try {
    cli = await runCli(
      opts.automationDir,
      { ...process.env, AQE_BASE_URL: service.url, AQE_RUN_DIR: opts.runDir, NODE_PATH: path.join(ROOT, 'node_modules'), FORCE_COLOR: '0', CI: '1' },
      opts.timeoutMs,
    );
  } finally {
    await service.close();
  }
  fs.writeFileSync(path.join(opts.runDir, 'playwright-output.log'), maskText(cli.output));
  const reportFile = path.join(opts.runDir, 'playwright-report.json');
  const report = fs.existsSync(reportFile) ? (JSON.parse(fs.readFileSync(reportFile, 'utf8')) as PwReport) : { suites: [] };
  const specs = report.suites.flatMap((s) => collectSpecs(s));
  const evidenceRoot = path.join(opts.runDir, 'evidence');

  const results: ExecutionResult[] = opts.scripts.map((script) => {
    const tcId = script.testCaseId;
    const spec = specs.find((s) => s.title.startsWith(`${tcId} `));
    const r = spec?.tests[0]?.results.at(-1);
    const id = `EX-${tcId}`;
    if (!r) return { id, testCaseId: tcId, scriptId: script.id, datasetId: script.datasetId, status: 'not-run', durationMs: 0, startedAt: null, error: null, evidence: [] };
    const dir = path.join(evidenceRoot, tcId);
    fs.mkdirSync(dir, { recursive: true });
    const evidence: EvidenceItem[] = [];
    const add = (kind: EvidenceItem['kind'], file: string, label: string) =>
      evidence.push({ id: `EV-${tcId}-${String(evidence.length + 1).padStart(2, '0')}`, kind, path: rel(opts.home, file), label });
    r.attachments.forEach((a, i) => {
      const ext = a.contentType === 'image/png' ? 'png' : a.contentType === 'application/zip' || a.name === 'trace' ? 'zip' : a.contentType.includes('json') ? 'json' : 'txt';
      const target = path.join(dir, `${String(i + 1).padStart(2, '0')}-${a.name.replace(/[^\w.-]/g, '_')}.${ext}`);
      if (a.path && fs.existsSync(a.path)) fs.copyFileSync(a.path, target);
      else if (a.body) fs.writeFileSync(target, ext === 'json' || ext === 'txt' ? maskText(Buffer.from(a.body, 'base64').toString('utf8')) : Buffer.from(a.body, 'base64'));
      else return;
      const kind: EvidenceItem['kind'] = a.name === 'trace' ? 'trace' : a.name.startsWith('screenshot') ? 'screenshot' : a.name.startsWith('request-response') ? 'request-response' : 'stdout';
      add(kind, target, a.name === 'trace' ? 'Playwright trace (open with npx playwright show-trace)' : a.name);
    });
    const serviceLog = service.log.filter((l) => l.testId === tcId);
    const logFile = path.join(dir, 'service-log.json');
    fs.writeFileSync(logFile, `${JSON.stringify(serviceLog, null, 2)}\n`);
    add('service-log', logFile, `Demo service log (${serviceLog.length} masked GraphQL calls)`);
    const rawError = r.errors?.[0]?.message ?? r.error?.message;
    const error = rawError ? parseError(rawError) : null;
    if (error) {
      const errFile = path.join(dir, 'error.txt');
      fs.writeFileSync(errFile, `${error.message}\n`);
      add('error', errFile, 'Assertion failure');
    }
    const status: ExecutionResult['status'] = r.status === 'passed' ? 'passed' : r.status === 'skipped' ? 'skipped' : 'failed';
    return { id, testCaseId: tcId, scriptId: script.id, datasetId: script.datasetId, status, durationMs: r.duration, startedAt: r.startTime, error, evidence };
  });

  // Keep the masked report without inline attachment bodies; evidence has been copied out.
  const stripped = JSON.parse(JSON.stringify(report, (k, v) => (k === 'body' ? undefined : v)));
  fs.writeFileSync(reportFile, maskText(JSON.stringify(stripped, null, 2)));
  fs.rmSync(path.join(opts.runDir, 'test-output'), { recursive: true, force: true });

  const count = (s: ExecutionResult['status']) => results.filter((x) => x.status === s).length;
  const finished = new Date();
  return {
    runId: opts.runId,
    executed: results.some((x) => x.status !== 'not-run'),
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    demoServiceBuild: service.build,
    baseURL: service.url,
    playwrightExitCode: cli.code,
    totals: { total: results.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), notRun: count('not-run') },
    results,
  };
}
