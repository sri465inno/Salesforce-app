/**
 * npm run scan:secrets — scans source, fixtures, generated automation, evidence and reports for
 * credentials, tokens, private keys and payment-card numbers. Exits 1 on any finding.
 */
import path from 'node:path';
import { ROOT, aqeHome } from '../src/shared/paths';
import { scanForSecrets } from '../src/platform/privacy';

const source = scanForSecrets(['src', 'scripts', 'tests', 'fixtures', 'contracts', 'force-app', 'README.md', 'docs', 'aqe.config.json'].map((p) => path.join(ROOT, p)), ROOT);
const generated = scanForSecrets([aqeHome()], ROOT, true);
const findings = [...source.findings, ...generated.findings];
console.log(`Secret scan: ${source.filesScanned} source files, ${generated.filesScanned} generated files (${path.relative(ROOT, aqeHome()) || aqeHome()}).`);
for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.rule}  ${f.preview}`);
if (findings.length) {
  console.error(`${findings.length} finding(s).`);
  process.exit(1);
}
console.log('No secrets, credentials or card numbers found.');
