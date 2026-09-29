/**
 * Agentic QE platform HTTP API + UI. Local only (binds 127.0.0.1). Every artifact, export and
 * evidence access, approval, execution, reset and deletion is written to the audit log.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import { BROWSER_DIST, ROOT } from '../shared/paths';
import { maskDeep } from '../shared/mask';
import { AqeConfig, loadConfig } from './config';
import { Store } from './store';
import { GovernanceError, Pipeline, STAGES } from './pipeline';
import { buildTrace, loadBundle, reportId, searchTrace, traceWorkbook } from './bundle';
import { INPUT_FILES, loadInputs } from './inputs';
import { listLab, runLab } from './lab';
import { applyRetention, deleteEvidence, resetWorkspace } from './retention';
import { assertProvenance, validateDataset } from './agents/test-data';
import { Metrics } from './agents/reporting';
import { CycleConfig, Dataset, GateId, SKILLS, TEST_TYPES } from './types';

export const AGENTS = [
  { name: 'Review Agent', role: 'Finds missing, duplicate and conflicting requirements and recommends corrections. Never approves or edits.' },
  { name: 'Requirements Agent', role: 'Normalizes inputs into a versioned requirements repository with source provenance.' },
  { name: 'Business Rules Agent', role: 'Extracts validations, constraints, decisions and outcomes linked to source requirements and code.' },
  { name: 'Test Design Agent', role: 'Generates smoke, positive, negative, boundary and end-to-end cases and the coverage matrix.' },
  { name: 'Test Data Agent', role: 'One deterministic SYNTHETIC dataset per test case, validated against the data dictionary.' },
  { name: 'Automation Agent', role: 'Generates Playwright UI and GraphQL API specs, fixtures, assertions and utilities.' },
  { name: 'Execution Agent', role: 'Runs the suite against the local demo service and captures screenshots, traces, logs, requests and timings.' },
  { name: 'Defect Intelligence Agent', role: 'Creates defects only from actual failures with expected/actual, severity, impact, evidence, cause and remediation.' },
  { name: 'Reporting Agent', role: 'Deterministic metrics, reports and a rules-based release recommendation.' },
];

export interface PlatformOptions {
  store?: Store;
  config?: AqeConfig;
}

export function createPlatformApp(opts: PlatformOptions = {}) {
  const store = opts.store ?? new Store();
  const config = opts.config ?? loadConfig();
  const pipeline = new Pipeline(store, config);
  const interrupted = pipeline.recoverInterrupted();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const uiDir = path.join(ROOT, 'src', 'ui');
  const actorOf = (req: Request) => String(req.header('x-aqe-user') || req.body?.actor || 'anonymous').slice(0, 80);
  const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };
  const cycleOr404 = (id: string) => {
    const c = store.getCycle(id);
    if (!c) throw Object.assign(new Error(`Cycle ${id} not found`), { status: 404 });
    return c;
  };

  app.get('/', (_req, res) => res.sendFile(path.join(uiDir, 'index.html')));
  app.get('/styles.css', (_req, res) => res.sendFile(path.join(uiDir, 'styles.css')));
  app.get('/app.js', (_req, res) => {
    const file = path.join(BROWSER_DIST, 'ui', 'app.js');
    if (!fs.existsSync(file)) return res.status(500).type('text').send('UI bundle missing: run npm run build');
    return res.type('application/javascript').sendFile(file);
  });

  app.get('/api/overview', (_req, res) => {
    const cycles = store.listCycles();
    const latest = cycles.at(-1) ?? null;
    const metrics = latest ? store.readArtifact<Metrics>(latest.id, 'reports/metrics.json') : null;
    res.json({
      platform: 'Agentic QE Platform — Salesforce reservation management (local MVP)',
      agents: AGENTS,
      stages: STAGES,
      gates: STAGES.filter((s) => s.gate).map((s) => ({ id: s.gate, name: s.name })),
      lineage: ['Requirement', 'Business Rule', 'Test Case', 'Test Data', 'Automation Script', 'Execution Result', 'Evidence', 'Defect', 'Report'],
      cycles: cycles.map((c) => ({ id: c.id, status: c.status, mode: c.config.mode, createdAt: c.createdAt, build: c.demoServiceBuild, baselineId: c.baselineId })),
      latest: latest ? { id: latest.id, status: latest.status, metrics } : null,
      interruptedOnStartup: interrupted,
      config: { evidenceRetentionDays: config.evidenceRetentionDays, deleteEvidenceOnReset: config.deleteEvidenceOnReset, maskSensitiveValues: config.maskSensitiveValues, localOnly: config.localOnly },
      options: { testingTypes: TEST_TYPES, skills: SKILLS, channels: ['ui', 'api'], inputs: Object.keys(INPUT_FILES) },
    });
  });

  app.get('/api/inputs', wrap((_req, res) => {
    const inputs = loadInputs(Object.keys(INPUT_FILES));
    res.json(inputs.documents.map(({ key, file, sha256, recordedFrom }) => ({ key, file, sha256, recordedFrom })));
  }));

  app.get('/api/cycles', (_req, res) => res.json(store.listCycles()));
  app.post('/api/cycles', wrap((req, res) => {
    const body = req.body as Partial<CycleConfig>;
    const cfg: CycleConfig = {
      mode: body.mode === 'incremental' ? 'incremental' : 'baseline',
      testingTypes: (body.testingTypes ?? TEST_TYPES).filter((t) => TEST_TYPES.includes(t)),
      channels: (body.channels ?? ['ui', 'api']).filter((c) => c === 'ui' || c === 'api'),
      inputs: body.inputs ?? Object.keys(INPUT_FILES),
      skills: (body.skills ?? [...SKILLS]).filter((s) => (SKILLS as readonly string[]).includes(s)),
      requestedBy: String(body.requestedBy || actorOf(req)).slice(0, 80),
      ...(Array.isArray(body.fixedDefects) && body.fixedDefects.length ? { fixedDefects: body.fixedDefects.filter((d) => d === 'BR-002') } : {}),
    };
    const cycle = pipeline.createCycle(cfg);
    void pipeline.advance(cycle.id);
    res.status(201).json(cycle);
  }));
  app.get('/api/cycles/:id', wrap((req, res) => {
    const c = cycleOr404(String(req.params.id));
    res.json({ ...c, running: pipeline.isRunning(c.id) });
  }));
  app.post('/api/cycles/:id/resume', wrap((req, res) => {
    const id = String(req.params.id);
    void pipeline.resume(id, actorOf(req)).catch(() => undefined);
    res.json(store.getCycle(id));
  }));
  app.post('/api/cycles/:id/approvals', wrap((req, res) => {
    const id = String(req.params.id);
    const { gate, approver, decision, comments, findingDecisions } = req.body as { gate: GateId; approver: string; decision: 'approved' | 'rejected'; comments?: string; findingDecisions?: [] };
    const c = pipeline.approve(id, gate, { approver, decision, comments, findingDecisions });
    if (c.status === 'running') void pipeline.advance(id);
    res.json(c);
  }));
  app.get('/api/cycles/:id/bundle', wrap((req, res) => {
    const b = loadBundle(store, cycleOr404(String(req.params.id)));
    const id = b.cycle.id;
    res.json(maskDeep({
      ...b,
      metrics: store.readArtifact<Metrics>(id, 'reports/metrics.json'),
      excluded: store.readArtifact(id, 'tests/excluded.json') ?? [],
      manifest: store.readArtifact(id, 'inputs/manifest.json') ?? [],
      reportId: reportId(id),
    }));
  }));
  app.get('/api/cycles/:id/trace', wrap((req, res) => {
    const b = loadBundle(store, cycleOr404(String(req.params.id)));
    res.json({ rows: searchTrace(buildTrace(b).rows, String(req.query.q ?? '')) });
  }));
  app.get('/api/cycles/:id/trace/:node', wrap((req, res) => {
    const b = loadBundle(store, cycleOr404(String(req.params.id)));
    const { nodes } = buildTrace(b);
    const n = nodes[String(req.params.node)];
    if (!n) return res.status(404).json({ error: `No trace node ${req.params.node} in ${b.cycle.id}` });
    const find = (id: string) => {
      const all: unknown[] = [...b.requirements, ...b.rules, ...b.testCases, ...b.datasets, ...b.scripts, ...(b.execution?.results ?? []), ...(b.execution?.results.flatMap((r) => r.evidence) ?? []), ...b.defects];
      return (all as { id: string }[]).find((x) => x.id === id) ?? (id === reportId(b.cycle.id) ? { id, metrics: store.readArtifact(b.cycle.id, 'reports/metrics.json') } : null);
    };
    // Full upstream lineage (walk to the requirement) and immediate downstream.
    const upstream: string[] = [];
    const walk = (id: string) => nodes[id]?.up.forEach((u) => {
      if (!upstream.includes(u)) {
        upstream.push(u);
        walk(u);
      }
    });
    walk(n.id);
    return res.json(maskDeep({ node: n, data: find(n.id), up: n.up.map((u) => nodes[u]), down: n.down.map((d) => nodes[d]), lineage: upstream.map((u) => nodes[u]) }));
  }));
  app.get('/api/cycles/:id/export.json', wrap((req, res) => {
    const b = loadBundle(store, cycleOr404(String(req.params.id)));
    store.audit({ actor: actorOf(req), actorType: 'human', action: 'access', target: `${b.cycle.id}/export.json`, details: {} });
    const { nodes, rows } = buildTrace(b);
    res.setHeader('Content-Disposition', `attachment; filename="traceability-${b.cycle.id}.json"`);
    res.json(maskDeep({ cycleId: b.cycle.id, reportId: reportId(b.cycle.id), classification: 'SYNTHETIC', generatedAt: new Date().toISOString(), rows, nodes }));
  }));
  app.get('/api/cycles/:id/export.xlsx', wrap(async (req, res) => {
    const b = loadBundle(store, cycleOr404(String(req.params.id)));
    store.audit({ actor: actorOf(req), actorType: 'human', action: 'access', target: `${b.cycle.id}/export.xlsx`, details: {} });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="traceability-${b.cycle.id}.xlsx"`);
    res.send(await traceWorkbook(b));
  }));
  app.delete('/api/cycles/:id/evidence', wrap((req, res) => {
    const id = String(req.params.id);
    cycleOr404(id);
    res.json(deleteEvidence(store, id, actorOf(req), String(req.body?.reason ?? 'manual deletion')));
  }));

  app.get('/api/lab', (_req, res) => res.json(maskDeep(listLab(store))));
  app.post('/api/lab', wrap(async (req, res) => {
    const { scenario, approver, requestedBy } = req.body as { scenario: string; approver: string; requestedBy?: string };
    res.status(201).json(maskDeep(await runLab(store, config, { scenario, approver, requestedBy: requestedBy ?? approver })));
  }));

  app.post('/api/datasets/validate', wrap((req, res) => {
    const ds = req.body as Dataset;
    try {
      assertProvenance(ds, config.approvedDatasetGenerators);
    } catch (err) {
      return res.status(422).json({ accepted: false, reason: (err as Error).message });
    }
    const validation = validateDataset(ds, loadInputs(Object.keys(INPUT_FILES)).dictionary);
    return res.json({ accepted: validation.status === 'valid', validation });
  }));

  app.get('/api/audit', (req, res) => {
    store.audit({ actor: actorOf(req), actorType: 'human', action: 'access', target: 'audit-log', details: {} });
    res.json(store.auditLog());
  });
  app.post('/api/retention/apply', wrap((req, res) => res.json({ retentionDays: config.evidenceRetentionDays, removed: applyRetention(store, config, actorOf(req)) })));
  app.post('/api/reset', wrap((req, res) => res.json(resetWorkspace(store, config, actorOf(req)))));

  app.get(/^\/artifacts\/(.+)$/, (req, res) => {
    const relPath = decodeURIComponent((req.params as unknown as string[])[0]);
    const file = path.resolve(store.home, relPath);
    if (!file.startsWith(path.resolve(store.home) + path.sep) || (relPath.startsWith('state/') && !relPath.startsWith('state/baselines/')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.status(404).send('Not found');
    store.audit({ actor: actorOf(req), actorType: 'human', action: 'access', target: `artifacts/${relPath}`, details: {} });
    if (/\.(ts|md|jsonl|log)$/.test(file)) res.type('text/plain; charset=utf-8');
    return res.sendFile(file, { dotfiles: 'allow' });
  });

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const status = err instanceof GovernanceError ? 409 : err.status ?? 500;
    res.status(status).json({ error: err.message });
  });
  return { app, store, pipeline, config };
}

export async function startPlatform(port: number, opts: PlatformOptions = {}): Promise<{ url: string; close(): Promise<void>; pipeline: Pipeline; store: Store }> {
  const p = createPlatformApp(opts);
  const server = http.createServer(p.app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, pipeline: p.pipeline, store: p.store, close: () => new Promise<void>((r) => server.close(() => r())) };
}
