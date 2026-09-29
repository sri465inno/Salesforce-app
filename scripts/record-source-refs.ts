/**
 * Records fixtures/inputs/source-code-references.json by indexing `@rule <id> <code>` markers
 * in the Apex service layer and its runnable Node port. Run: npm run record:source-refs
 */
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR, ROOT } from '../src/shared/paths';
import { buildSourceReferences } from '../src/platform/source-refs';

const out = path.join(FIXTURES_DIR, 'source-code-references.json');
fs.writeFileSync(out, `${JSON.stringify(buildSourceReferences(ROOT), null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, out)}`);
