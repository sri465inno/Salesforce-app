/** Workflow state is persisted: a cycle whose process dies mid-stage is detected as interrupted and resumes after restart. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { Pipeline } from '../../src/platform/pipeline';
import { ROOT } from '../../src/shared/paths';
import type { ReviewFinding } from '../../src/platform/types';
import { HUMAN, config, tempStore } from './helpers';

test('process crash during business-rule extraction, then recover and resume', async () => {
  const store = tempStore('resume');
  const child = `
    const { Store } = require('./dist/src/platform/store');
    const { Pipeline } = require('./dist/src/platform/pipeline');
    const { loadConfig } = require('./dist/src/platform/config');
    const { INPUT_FILES } = require('./dist/src/platform/inputs');
    (async () => {
      const store = new Store(process.env.AQE_HOME);
      const p = new Pipeline(store, loadConfig());
      const c = p.createCycle({ mode: 'baseline', testingTypes: ['smoke', 'positive', 'negative', 'boundary', 'e2e'], channels: ['ui', 'api'], inputs: Object.keys(INPUT_FILES), skills: [], requestedBy: ${JSON.stringify(HUMAN)} });
      await p.advance(c.id);
      const findings = store.readArtifact(c.id, 'review/findings.json');
      p.approve(c.id, 'requirements-baseline', { approver: ${JSON.stringify(HUMAN)}, decision: 'approved', comments: 'ok', findingDecisions: findings.map((f) => ({ findingId: f.id, decision: 'accept' })) });
      await p.advance(c.id);
    })();`;
  const r = spawnSync(process.execPath, ['-e', child], { cwd: ROOT, env: { ...process.env, AQE_HOME: store.home, AQE_SIMULATE_CRASH_AT: 'business-rules' }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(86);

  const before = store.listCycles()[0];
  expect(before.stages.find((s) => s.id === 'business-rules')?.status).toBe('running');
  const intakeFinished = before.stages[0].finishedAt;

  const pipeline = new Pipeline(store, config);
  expect(pipeline.recoverInterrupted()).toEqual([before.id]);
  expect(store.getCycle(before.id)?.status).toBe('interrupted');
  const resumed = await pipeline.resume(before.id, HUMAN);
  expect(resumed.status).toBe('waiting-approval');
  expect(resumed.stages.find((s) => s.status === 'waiting-approval')?.gate).toBe('test-design');
  expect(resumed.stages[0].finishedAt).toBe(intakeFinished);
  expect(store.readArtifact<ReviewFinding[]>(before.id, 'review/findings.json')?.length).toBeGreaterThan(0);
  const events = store.auditLog().filter((a) => a.target === before.id).map((a) => (a.details as { event?: string }).event);
  expect(events).toEqual(expect.arrayContaining(['interrupted', 'resumed']));
  expect(path.isAbsolute(store.home)).toBe(true);
});
