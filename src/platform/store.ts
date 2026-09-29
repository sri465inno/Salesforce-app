/** Local JSON persistence with atomic writes; all state lives under AQE_HOME. */
import fs from 'node:fs';
import path from 'node:path';
import { aqeHome, rel } from '../shared/paths';
import { maskDeep } from '../shared/mask';
import { AuditEntry, Cycle } from './types';

interface Meta {
  nextCycle: number;
  nextBaseline: number;
  nextLab: number;
  nextApproval: number;
}

export class Store {
  readonly home: string;
  readonly stateDir: string;
  readonly auditFile: string;

  constructor(home = aqeHome()) {
    this.home = home;
    this.stateDir = path.join(home, 'state');
    this.auditFile = path.join(home, 'audit', 'audit.jsonl');
    this.init();
  }

  /** Creates the workspace layout and counters if missing (also used after a reset). */
  init(): void {
    for (const d of ['state/cycles', 'state/baselines', 'state/lab', 'audit', 'cycles', 'lab']) fs.mkdirSync(path.join(this.home, d), { recursive: true });
    if (!fs.existsSync(this.metaFile)) this.writeJson(this.metaFile, { nextCycle: 1, nextBaseline: 1, nextLab: 1, nextApproval: 1 } satisfies Meta);
  }

  private get metaFile() {
    return path.join(this.stateDir, 'meta.json');
  }

  writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  writeText(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  readJson<T>(file: string): T | null {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null;
  }

  next(key: keyof Meta): number {
    const meta = this.readJson<Meta>(this.metaFile)!;
    const n = meta[key] ?? 1;
    meta[key] = n + 1;
    this.writeJson(this.metaFile, meta);
    return n;
  }

  cycleDir(id: string): string {
    return path.join(this.home, 'cycles', id);
  }

  /** Writes a cycle artifact and returns its AQE_HOME-relative path. */
  artifact(cycleId: string, relPath: string, value: unknown): string {
    const file = path.join(this.cycleDir(cycleId), relPath);
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    } else this.writeJson(file, value);
    return this.relPath(file);
  }

  readArtifact<T>(cycleId: string, relPath: string): T | null {
    return this.readJson<T>(path.join(this.cycleDir(cycleId), relPath));
  }

  relPath(file: string): string {
    return rel(this.home, file);
  }

  saveCycle(cycle: Cycle): void {
    cycle.updatedAt = new Date().toISOString();
    this.writeJson(path.join(this.stateDir, 'cycles', `${cycle.id}.json`), cycle);
  }

  getCycle(id: string): Cycle | null {
    if (!/^CYC-\d{4}$/.test(id)) return null;
    return this.readJson<Cycle>(path.join(this.stateDir, 'cycles', `${id}.json`));
  }

  listCycles(): Cycle[] {
    const dir = path.join(this.stateDir, 'cycles');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => this.readJson<Cycle>(path.join(dir, f))!)
      .filter(Boolean);
  }

  saveBaseline(id: string, value: unknown): void {
    this.writeJson(path.join(this.stateDir, 'baselines', `${id}.json`), value);
  }

  getBaseline<T>(id: string): T | null {
    return this.readJson<T>(path.join(this.stateDir, 'baselines', `${id}.json`));
  }

  audit(entry: Omit<AuditEntry, 'seq' | 'at'>): AuditEntry {
    const seq = fs.existsSync(this.auditFile) ? fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).length + 1 : 1;
    const full: AuditEntry = { seq, at: new Date().toISOString(), ...entry, details: maskDeep(entry.details) };
    fs.appendFileSync(this.auditFile, `${JSON.stringify(full)}\n`);
    return full;
  }

  auditLog(): AuditEntry[] {
    if (!fs.existsSync(this.auditFile)) return [];
    return fs
      .readFileSync(this.auditFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry);
  }
}
