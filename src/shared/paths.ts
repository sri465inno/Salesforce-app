import path from 'node:path';

/** Repository root. Compiled files live in dist/src/<area>/, sources in src/<area>/. */
export const ROOT = path.resolve(__dirname, __dirname.includes(`${path.sep}dist${path.sep}`) ? '../../..' : '../..');

export const FIXTURES_DIR = path.join(ROOT, 'fixtures', 'inputs');
export const CONTRACT_FILE = path.join(ROOT, 'contracts', 'reservation.graphql');
export const BROWSER_DIST = path.join(ROOT, 'dist', 'browser');

/** Where all platform state and generated artifacts are written (default demo-artifacts/). */
export function aqeHome(): string {
  return path.resolve(process.env.AQE_HOME || path.join(ROOT, 'demo-artifacts'));
}

export function rel(from: string, file: string): string {
  return path.relative(from, file).split(path.sep).join('/');
}
