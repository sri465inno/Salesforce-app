import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../shared/hash';

export const SOURCE_FILES = [
  'force-app/main/default/classes/ReservationValidator.cls',
  'force-app/main/default/classes/ReservationService.cls',
  'src/demo-service/reservation-validator.ts',
  'src/demo-service/reservation-service.ts',
];

export interface SourceReference {
  ruleId: string;
  code: string;
  file: string;
  line: number;
  symbol: string;
  layer: 'apex' | 'node-port';
  excerpt: string[];
}

export interface SourceReferences {
  recordedFrom: string;
  files: { file: string; sha256: string }[];
  references: SourceReference[];
}

const MARKER = /@rule\s+(BR-[A-Z0-9]+)\s+([A-Z_]+)/;
const SYMBOL = /(?:function|static\s+\w+(?:<[^>]+>)?\s+|private\s+|public\s+)\s*(\w+)\s*\(/;

export function buildSourceReferences(root: string): SourceReferences {
  const references: SourceReference[] = [];
  const files = SOURCE_FILES.map((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const m = MARKER.exec(line);
      if (!m) return;
      const inline = !line.trim().startsWith('//');
      const start = inline ? i : i + 1;
      const excerpt: string[] = [];
      for (let j = start; j < lines.length && excerpt.length < 12; j++) {
        if (j > start && MARKER.test(lines[j])) break;
        excerpt.push(lines[j]);
        if (j > start && /^\s{0,4}}\s*$/.test(lines[j])) break;
        if (inline) break;
      }
      const symbol = inline ? (/(\w+)\s*\(/.exec(line)?.[1] ?? 'inline') : (SYMBOL.exec(lines[start] ?? '')?.[1] ?? 'unknown');
      references.push({ ruleId: m[1], code: m[2], file, line: start + 1, symbol, layer: file.endsWith('.cls') ? 'apex' : 'node-port', excerpt });
    });
    return { file, sha256: sha256(text) };
  });
  return { recordedFrom: 'Indexed from @rule markers in the repository source by scripts/record-source-refs.ts', files, references };
}
