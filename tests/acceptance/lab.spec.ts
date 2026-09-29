/** Test Lab: plain-language scenario -> test case -> SYNTHETIC data -> automation -> approved execution -> trace chain. */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { runLab, listLab } from '../../src/platform/lab';
import { HUMAN, config, tempStore } from './helpers';

const store = tempStore('lab');

test('customer count 0 scenario runs for real, fails on the seeded build and yields a traceable defect', async () => {
  const r = await runLab(store, config, { scenario: 'A reservation with customer count 0 should be rejected', requestedBy: HUMAN, approver: HUMAN });
  expect(r.interpretation).toMatchObject({ ruleId: 'BR-002', expectation: 'rejected', mutation: { customerCount: 0 } });
  expect(r.dataset.classification).toBe('SYNTHETIC');
  expect(r.dataset.values.customerCount).toBe(0);
  expect(r.status).toBe('failed');
  expect(r.execution?.status).toBe('failed');
  expect(r.defects).toHaveLength(1);
  expect(r.defects[0]).toMatchObject({ ruleId: 'BR-002', createdFrom: 'execution-failure' });
  const types = r.chain.map((l) => l.type);
  expect([...new Set(types)]).toEqual(['requirement', 'rule', 'test-case', 'dataset', 'script', 'execution', 'evidence', 'defect']);
  const script = fs.readFileSync(path.join(store.home, r.script!.file), 'utf8');
  expect(script).toContain(r.dataset.id);
  expect(script).toContain('BR-002');
  for (const l of r.chain.filter((x) => x.path)) expect(fs.existsSync(path.join(store.home, l.path!)), l.path).toBe(true);
});

test('valid UI scenario is confirmed and passes; no defect is invented', async () => {
  const r = await runLab(store, config, { scenario: 'In the console, a reservation for 3 customers should be confirmed', requestedBy: HUMAN, approver: HUMAN });
  expect(r.interpretation).toMatchObject({ channel: 'ui', expectation: 'accepted', mutation: { customerCount: 3 } });
  expect(r.status).toBe('passed');
  expect(r.defects).toHaveLength(0);
  expect(r.execution?.evidence.some((e) => e.kind === 'screenshot')).toBe(true);
});

test('invalid payment method scenario is rejected by the service (BR-004) and passes', async () => {
  const r = await runLab(store, config, { scenario: 'Payment method CASH should be rejected', requestedBy: HUMAN, approver: HUMAN });
  expect(r.interpretation.ruleId).toBe('BR-004');
  expect(r.status).toBe('passed');
});

test('contradictory scenarios are blocked before execution; agents cannot approve', async () => {
  const r = await runLab(store, config, { scenario: 'A reservation with customer count 3 should be rejected', requestedBy: HUMAN, approver: HUMAN });
  expect(r.status).toBe('blocked');
  expect(r.execution).toBeNull();
  await expect(runLab(store, config, { scenario: 'A reservation with customer count 0 should be rejected', requestedBy: HUMAN, approver: 'Execution Agent' })).rejects.toThrow(/cannot approve/);
  expect(listLab(store).map((x) => x.status)).toEqual(['failed', 'passed', 'passed', 'blocked']);
});
