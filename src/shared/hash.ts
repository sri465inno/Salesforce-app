import crypto from 'node:crypto';

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Deterministic PRNG (mulberry32) seeded from a string, so generated data is reproducible. */
export function seededRandom(seed: string): () => number {
  let a = parseInt(sha256(seed).slice(0, 8), 16);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

export function pad(n: number, width = 3): string {
  return String(n).padStart(width, '0');
}
