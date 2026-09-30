/**
 * Requirements Agent: normalizes supplied inputs into a versioned requirements repository.
 * Every item keeps its source provenance (file, JSON path, sha256, recordedFrom). Versions
 * increase only when the normalized text changes relative to the previous baseline.
 */
import { sha256, pad } from '../../shared/hash';
import { Inputs } from '../inputs';
import { Requirement } from '../types';

export const AGENT = 'Requirements Agent';

export function normalizeRequirements(inputs: Inputs, previous: Requirement[] = []): Requirement[] {
  const doc = (key: string) => inputs.documents.find((d) => d.key === key)!;
  const items: Omit<Requirement, 'id' | 'version' | 'contentHash' | 'status'>[] = [];
  const s = inputs.story;
  const storyDoc = doc('story');
  items.push({
    kind: 'story',
    text: `As a ${s.narrative.asA}, I want ${s.narrative.iWant}, so that ${s.narrative.soThat}.`,
    sourceId: s.id,
    provenance: { source: storyDoc.file, path: '#/narrative', sha256: storyDoc.sha256, recordedFrom: storyDoc.recordedFrom },
  });
  s.acceptanceCriteria.forEach((ac, i) =>
    items.push({
      kind: 'acceptance-criterion',
      text: ac.text,
      sourceId: ac.id,
      provenance: { source: storyDoc.file, path: `#/acceptanceCriteria/${i}`, sha256: storyDoc.sha256, recordedFrom: storyDoc.recordedFrom },
    }),
  );
  if (inputs.epic) {
    const epicDoc = doc('epic');
    inputs.epic.acceptanceCriteria.forEach((ac, i) =>
      items.push({
        kind: 'epic-criterion',
        text: ac.text,
        sourceId: ac.id,
        provenance: { source: epicDoc.file, path: `#/acceptanceCriteria/${i}`, sha256: epicDoc.sha256, recordedFrom: epicDoc.recordedFrom },
      }),
    );
  }
  const rulesDoc = doc('business-rules');
  inputs.rules.rules.forEach((r, i) =>
    items.push({
      kind: 'business-rule-statement',
      text: r.text,
      sourceId: r.id,
      provenance: { source: rulesDoc.file, path: `#/rules/${i}`, sha256: rulesDoc.sha256, recordedFrom: rulesDoc.recordedFrom },
    }),
  );

  return items.map((item, i) => {
    const contentHash = sha256(item.text.trim().toLowerCase());
    const prior = previous.find((p) => p.sourceId === item.sourceId);
    const version = !prior ? 1 : prior.contentHash === contentHash ? prior.version : prior.version + 1;
    return { id: prior?.id ?? `REQ-${pad(i + 1)}`, ...item, version, contentHash, status: 'draft' as const };
  });
}

export function changedSince(current: Requirement[], previous: Requirement[]): string[] {
  return current.filter((r) => !previous.some((p) => p.sourceId === r.sourceId && p.contentHash === r.contentHash)).map((r) => r.id);
}
