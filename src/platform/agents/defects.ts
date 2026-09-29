/**
 * Defect Intelligence Agent: creates defects only from actual failed execution results.
 * Failures are grouped by business rule; each defect carries expected vs actual, severity,
 * impact, evidence links, a code-located suspected cause and a suggested remediation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../shared/paths';
import { maskText } from '../../shared/mask';
import { BusinessRule, Dataset, Defect, ExecutionResult, TestCase } from '../types';

export const AGENT = 'Defect Intelligence Agent';

interface RequestResponse { request: { variables: { input?: Record<string, unknown> } }; response: { body: { data?: { createReservation?: { success: boolean; errors: { code: string }[]; reservation: { confirmationNumber: string; status: string } | null } } } } }

function observedResponse(result: ExecutionResult, home: string): string | null {
  const ev = result.evidence.find((e) => e.kind === 'request-response' && e.label.endsWith('createReservation'));
  if (!ev) return null;
  const rr = JSON.parse(fs.readFileSync(path.join(home, ev.path), 'utf8')) as RequestResponse;
  const p = rr.response.body.data?.createReservation;
  if (!p) return null;
  return p.success
    ? `createReservation returned success=true, status ${p.reservation?.status}, confirmation number ${p.reservation?.confirmationNumber}`
    : `createReservation returned success=false with ${p.errors.map((e) => e.code).join(', ')}`;
}

export function createDefects(opts: { results: ExecutionResult[]; testCases: TestCase[]; rules: BusinessRule[]; datasets: Dataset[]; home: string; idPrefix?: string; startAt?: number }): Defect[] {
  const failed = opts.results.filter((r) => r.status === 'failed');
  const byRule = new Map<string, ExecutionResult[]>();
  for (const r of failed) {
    const tc = opts.testCases.find((t) => t.id === r.testCaseId)!;
    const key = tc.ruleIds[0];
    byRule.set(key, [...(byRule.get(key) ?? []), r]);
  }
  let n = opts.startAt ?? 1;
  return [...byRule.entries()].map(([ruleId, group]) => {
    const rule = opts.rules.find((b) => b.id === ruleId)!;
    const tcs = group.map((g) => opts.testCases.find((t) => t.id === g.testCaseId)!);
    const first = tcs[0];
    const ds = opts.datasets.find((d) => d.testCaseId === first.id);
    const field = rule.check.fields[0];
    const value = ds ? readValue(ds, field) : undefined;
    const ref = rule.codeReferences.find((c) => c.file.startsWith('src/')) ?? rule.codeReferences[0] ?? null;
    const apex = rule.codeReferences.find((c) => c.file.endsWith('.cls'));
    const excerpt = ref ? readExcerpt(ref.file, ref.line) : [];
    const guard = excerpt.find((l) => l.includes(field.split('.').pop()!) && /[<>]=?|!/.test(l) && /\bif\b/.test(l))?.trim() ?? excerpt.find((l) => /\bif\b/.test(l))?.trim();
    const observed = group.map((g) => observedResponse(g, opts.home)).find(Boolean) ?? group[0].error?.actual ?? group[0].error?.message.split('\n')[0] ?? 'unknown';
    const severity = rule.criticality === 'critical' ? 'critical' : rule.criticality === 'high' ? 'high' : 'medium';
    const tcList = tcs.map((t) => t.id).join(', ');
    const isBoundary = rule.check.type === 'min-exclusive';
    return {
      id: `${opts.idPrefix ?? 'DEF-'}${String(n++).padStart(3, '0')}`,
      title: `${ruleId} not enforced: ${field} = ${JSON.stringify(value)} is accepted by createReservation`,
      status: 'open',
      severity,
      blocksRelease: severity === 'critical' || severity === 'high',
      ruleId,
      requirementIds: [...new Set(tcs.flatMap((t) => t.requirementIds))],
      testCaseIds: tcs.map((t) => t.id),
      executionIds: group.map((g) => g.id),
      evidenceIds: group.flatMap((g) => g.evidence.map((e) => e.id)),
      expected: `${rule.text} ${rule.expectedOutcome} when ${field} = ${JSON.stringify(value)} (${tcs.map((t) => `${t.id} ${t.channel.toUpperCase()}`).join(', ')}).`,
      actual: maskText(`${observed}.`),
      impact: `${rule.entity} records that violate ${ruleId} (${rule.condition}) are confirmed and receive a confirmation number, so fulfilment and occupancy reporting receive invalid reservations. Reproduced through ${[...new Set(tcs.map((t) => t.channel.toUpperCase()))].join(' and ')} in ${group.length} test(s).`,
      suspectedCause: ref
        ? `${isBoundary ? `Boundary value ${JSON.stringify(value)} for ${field} passes validation. ` : ''}The rule is enforced in ${ref.symbol} (${ref.file}:${ref.line})${guard ? ` by \`${guard}\`` : ''}; ${isBoundary ? `the lower bound admits ${JSON.stringify(value)} although ${ruleId} requires ${rule.condition.split(' and ')[0]}.` : `it did not produce ${rule.check.errorCode} for this input.`}`
        : `No code reference is recorded for ${ruleId}; the service did not return ${rule.check.errorCode}.`,
      codeReference: ref ? { ...ref, excerpt } : null,
      suggestedRemediation: isBoundary
        ? `Reject ${field} <= ${rule.check.parameters.threshold} in ${ref?.symbol ?? 'the validator'} (lower bound ${Number(rule.check.parameters.threshold) + 1})${apex ? ` and apply the same fix to ${apex.file}:${apex.line}` : ''}; then re-run ${tcList}.`
        : `Make ${ref?.symbol ?? 'the validator'} return ${rule.check.errorCode} for this input${apex ? ` (and ${apex.file}:${apex.line})` : ''}; then re-run ${tcList}.`,
      createdAt: new Date().toISOString(),
      createdFrom: 'execution-failure',
    } satisfies Defect;
  });
}

function readValue(ds: Dataset, field: string): unknown {
  const [head, tail] = field.split('.');
  const top = (ds.values as unknown as Record<string, unknown>)[head];
  return tail ? (top as Record<string, unknown>)?.[tail] : top;
}

function readExcerpt(file: string, line: number): string[] {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return [];
  return fs.readFileSync(full, 'utf8').split('\n').slice(line - 1, line + 7);
}
