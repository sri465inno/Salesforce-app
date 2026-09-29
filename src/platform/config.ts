import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../shared/paths';

export interface AqeConfig {
  evidenceRetentionDays: number;
  deleteEvidenceOnReset: boolean;
  maskSensitiveValues: boolean;
  localOnly: boolean;
  approvedDatasetGenerators: string[];
  platformPort: number;
  executionTimeoutMs: number;
}

const DEFAULTS: AqeConfig = {
  evidenceRetentionDays: 30,
  deleteEvidenceOnReset: true,
  maskSensitiveValues: true,
  localOnly: true,
  approvedDatasetGenerators: ['aqe-test-data-agent@1.0.0'],
  platformPort: 3000,
  executionTimeoutMs: 180000,
};

/** aqe.config.json, overridable with AQE_* environment variables. */
export function loadConfig(): AqeConfig {
  const file = path.join(ROOT, 'aqe.config.json');
  const fromFile = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AqeConfig>) : {};
  const cfg: AqeConfig = { ...DEFAULTS, ...fromFile };
  if (process.env.AQE_EVIDENCE_RETENTION_DAYS) cfg.evidenceRetentionDays = Number(process.env.AQE_EVIDENCE_RETENTION_DAYS);
  if (process.env.PORT) cfg.platformPort = Number(process.env.PORT);
  return cfg;
}
