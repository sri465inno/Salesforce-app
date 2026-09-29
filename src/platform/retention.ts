/** Evidence retention, deletion and reset. Every action is written to the audit log. */
import fs from 'node:fs';
import path from 'node:path';
import { AqeConfig } from './config';
import { Store } from './store';

function evidenceDirs(store: Store): { owner: string; dir: string }[] {
  const out: { owner: string; dir: string }[] = [];
  for (const base of ['cycles', 'lab']) {
    const root = path.join(store.home, base);
    if (!fs.existsSync(root)) continue;
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id, 'execution', 'evidence');
      if (fs.existsSync(dir)) out.push({ owner: id, dir });
    }
  }
  return out;
}

function countFiles(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);
}

export function deleteEvidence(store: Store, ownerId: string, actor: string, reason: string): { deleted: boolean; files: number } {
  const hit = evidenceDirs(store).find((e) => e.owner === ownerId);
  if (!hit) return { deleted: false, files: 0 };
  const files = countFiles(hit.dir);
  fs.rmSync(hit.dir, { recursive: true, force: true });
  store.audit({ actor, actorType: 'human', action: 'deletion', target: `${ownerId}/evidence`, details: { files, reason } });
  return { deleted: true, files };
}

/** Deletes evidence older than the configured retention period. */
export function applyRetention(store: Store, config: AqeConfig, actor: string, now = Date.now()): { owner: string; files: number }[] {
  const cutoff = now - config.evidenceRetentionDays * 86_400_000;
  const removed: { owner: string; files: number }[] = [];
  for (const e of evidenceDirs(store)) {
    if (fs.statSync(e.dir).mtimeMs < cutoff) {
      const files = countFiles(e.dir);
      fs.rmSync(e.dir, { recursive: true, force: true });
      removed.push({ owner: e.owner, files });
    }
  }
  store.audit({ actor, actorType: actor === 'platform' ? 'system' : 'human', action: 'retention', target: 'evidence', details: { retentionDays: config.evidenceRetentionDays, removed } });
  return removed;
}

/** Removes workflow state, cycles and lab runs. The audit log is kept and records the reset. */
export function resetWorkspace(store: Store, config: AqeConfig, actor: string): { removed: string[] } {
  const removed: string[] = [];
  for (const d of ['state', 'cycles', 'lab']) {
    if (d !== 'state' && !config.deleteEvidenceOnReset) continue;
    const dir = path.join(store.home, d);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(d);
    }
  }
  store.init();
  store.audit({ actor, actorType: 'human', action: 'reset', target: 'workspace', details: { removed, deleteEvidenceOnReset: config.deleteEvidenceOnReset } });
  return { removed };
}
