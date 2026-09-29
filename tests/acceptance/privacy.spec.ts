/** Privacy controls: provenance, synthetic data, masking, secret scanning, retention, deletion, reset and their audit trail. */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { assertProvenance, generateDataset } from '../../src/platform/agents/test-data';
import { INPUT_FILES, loadInputs } from '../../src/platform/inputs';
import { scanForSecrets } from '../../src/platform/privacy';
import { applyRetention, deleteEvidence, resetWorkspace } from '../../src/platform/retention';
import { maskDeep, maskText } from '../../src/shared/mask';
import { HUMAN, config, tempStore } from './helpers';

const inputs = loadInputs(Object.keys(INPUT_FILES));
const dictSha = inputs.documents.find((d) => d.key === 'data-dictionary')!.sha256;

test('datasets are deterministic, SYNTHETIC and validated; unknown provenance is rejected', () => {
  const tc = { id: 'TC-X', mutation: { customerCount: 2 }, violates: [] };
  const a = generateDataset(tc, inputs.dictionary, dictSha);
  const b = generateDataset(tc, inputs.dictionary, dictSha);
  expect({ ...a.values }).toEqual({ ...b.values });
  expect(a.classification).toBe('SYNTHETIC');
  expect(a.values.customer.email).toMatch(/@example\.test$/);
  expect(a.values.payment.paymentToken).toMatch(/^tok_synthetic_/);
  expect(a.validation.privacy.every((c) => c.result === 'pass')).toBe(true);
  expect(() => assertProvenance(a, config.approvedDatasetGenerators)).not.toThrow();
  expect(() => assertProvenance({ ...a, provenance: { ...a.provenance, generator: 'prod-export@2' } }, config.approvedDatasetGenerators)).toThrow(/provenance/i);
  expect(() => assertProvenance({ ...a, provenance: undefined }, config.approvedDatasetGenerators)).toThrow(/provenance/i);
  expect(() => assertProvenance({ ...a, classification: 'PRODUCTION' as unknown as 'SYNTHETIC' }, config.approvedDatasetGenerators)).toThrow(/SYNTHETIC/);
});

// Test values are assembled at runtime so this file stays clean for npm run scan:secrets.
const BEARER = ['abcdefghij', 'klmnopqrst', 'uvwxyz123456'].join('');
const CARD = ['4111', '1111', '1111', '1111'].join(' ');

test('sensitive values are masked in nested evidence and text', () => {
  const masked = maskDeep({ customer: { firstName: 'Avery', lastName: 'Synthwell', email: 'avery.synthwell@example.test' }, payment: { paymentToken: 'tok_synthetic_abcdef123456' }, note: `Authorization: ${'Bearer'} ${BEARER}` });
  const s = JSON.stringify(masked);
  expect(s).not.toContain('avery.synthwell@example.test');
  expect(s).not.toContain('tok_synthetic_abcdef123456');
  expect(s).not.toContain('Synthwell');
  expect(s).not.toContain(BEARER);
  expect(maskText(`card ${CARD}`)).not.toContain(CARD);
});

test('secret scanner flags credentials and card numbers, and passes clean content', () => {
  const store = tempStore('privacy-scan');
  const dir = path.join(store.home, 'planted');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'clean.json'), JSON.stringify({ confirmationNumber: 'CNF-AB12CD34', token: 'tok_synthetic_****3456' }));
  expect(scanForSecrets([dir], store.home).findings).toEqual([]);
  // Assembled at runtime so this source file itself stays clean for npm run scan:secrets.
  const planted = [`aws = "${'AKIA'}${'ABCDEFGHIJKLMNOP'}"`, `api_key = "${'s3cr3t'}${'value42'}"`, `pan ${'4111'}111111111111`, `raw ${'tok_synthetic_'}abcdef123456`].join('\n');
  fs.writeFileSync(path.join(dir, 'evidence.log'), planted);
  const rules = scanForSecrets([dir], store.home, true).findings.map((f) => f.rule);
  expect(rules).toEqual(expect.arrayContaining(['aws-access-key', 'credential-assignment', 'payment-card-number', 'unmasked-payment-token']));
});

test('retention, deletion and reset remove evidence per configuration and are audited', () => {
  const store = tempStore('privacy-retention');
  const old = path.join(store.home, 'lab', 'LAB-0001', 'execution', 'evidence');
  const fresh = path.join(store.home, 'lab', 'LAB-0002', 'execution', 'evidence');
  for (const d of [old, fresh]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'screenshot.png'), 'x');
  }
  const past = (Date.now() - (config.evidenceRetentionDays + 1) * 86_400_000) / 1000;
  fs.utimesSync(old, past, past);
  const removed = applyRetention(store, config, HUMAN);
  expect(removed.map((r) => r.owner)).toEqual(['LAB-0001']);
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(fresh)).toBe(true);
  expect(deleteEvidence(store, 'LAB-0002', HUMAN, 'demo cleanup')).toMatchObject({ deleted: true, files: 1 });
  expect(fs.existsSync(fresh)).toBe(false);
  const reset = resetWorkspace(store, config, HUMAN);
  expect(reset.removed.length).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(store.home, 'state', 'cycles'))).toBe(true);
  const actions = store.auditLog().map((a) => a.action);
  expect(actions).toEqual(expect.arrayContaining(['retention', 'deletion', 'reset']));
});
