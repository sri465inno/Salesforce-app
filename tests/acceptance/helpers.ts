import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../src/shared/paths';
import { loadConfig } from '../../src/platform/config';
import { Store } from '../../src/platform/store';

/** Fresh, isolated AQE_HOME for one test file. */
export function tempStore(name: string): Store {
  const home = path.join(ROOT, '.aqe-test', name);
  fs.rmSync(home, { recursive: true, force: true });
  return new Store(home);
}

export const config = loadConfig();

export const HUMAN = 'Priya Raman (QE Lead)';

export async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body as T;
}

export async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 180_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 300));
  }
}
