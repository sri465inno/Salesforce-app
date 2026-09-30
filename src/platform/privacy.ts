/** Secret scanning and masking verification for generated code, evidence and reports. */
import fs from 'node:fs';
import path from 'node:path';
import { luhn } from '../shared/mask';

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  preview: string;
}

const TEXT_EXT = new Set(['.ts', '.js', '.mjs', '.json', '.jsonl', '.md', '.txt', '.log', '.html', '.cls', '.xml', '.graphql', '.csv', '.css', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test-results', 'playwright-report']);

const RULES: { rule: string; re: RegExp }[] = [
  { rule: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { rule: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { rule: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { rule: 'credential-assignment', re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i },
];
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const RAW_TOKEN = /\btok_synthetic_[a-z0-9]{12}\b/;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  if (fs.statSync(dir).isFile()) {
    if (TEXT_EXT.has(path.extname(dir))) out.push(dir);
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (TEXT_EXT.has(path.extname(entry.name))) out.push(path.join(dir, entry.name));
  }
  return out;
}

/**
 * Scans text files under the given roots. `evidenceMode` additionally flags unmasked synthetic
 * payment tokens outside the dataset/automation sources, verifying that evidence was masked.
 */
export function scanForSecrets(roots: string[], base: string, evidenceMode = false): { filesScanned: number; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  let filesScanned = 0;
  for (const root of roots) {
    for (const file of walk(root)) {
      filesScanned++;
      const relFile = path.relative(base, file).split(path.sep).join('/');
      const allowTokens = /\/(data|automation)\//.test(`/${relFile}`) || relFile.endsWith('datasets.json');
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const { rule, re } of RULES) if (re.test(line)) findings.push({ file: relFile, line: i + 1, rule, preview: redact(line) });
          for (const m of line.match(CARD) ?? []) if (luhn(m.replace(/\D/g, ''))) findings.push({ file: relFile, line: i + 1, rule: 'payment-card-number', preview: '[redacted digits]' });
          if (evidenceMode && !allowTokens && RAW_TOKEN.test(line)) findings.push({ file: relFile, line: i + 1, rule: 'unmasked-payment-token', preview: redact(line) });
        });
    }
  }
  return { filesScanned, findings };
}

function redact(line: string): string {
  return line.trim().slice(0, 120).replace(/[A-Za-z0-9_-]{12,}/g, (m) => `${m.slice(0, 4)}…`);
}
