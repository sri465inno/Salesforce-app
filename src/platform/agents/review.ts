/**
 * Review Agent: identifies missing, duplicate and conflicting requirements and behavior that
 * exists only in code. It recommends corrections; it never approves, excludes or edits a
 * requirement. Accepted recommendations are applied only after a human decision (gate 1).
 */
import { pad } from '../../shared/hash';
import { Inputs, allFields } from '../inputs';
import { parseStatement } from '../statements';
import { FindingDecision, Requirement, ReviewFinding } from '../types';

export const AGENT = 'Review Agent';

export const CODE_ONLY_RULE_TEXT: Record<string, string> = {
  'BR-D01': 'Customer email must be valid.',
  'BR-D02': 'Payment must be authorized by the payment gateway.',
};

export function reviewRequirements(requirements: Requirement[], inputs: Inputs): ReviewFinding[] {
  const findings: Omit<ReviewFinding, 'id'>[] = [];
  const parsed = requirements.map((r) => ({ r, p: parseStatement(r.text, inputs.dictionary) }));
  const stories = parsed.filter((x) => x.r.kind === 'acceptance-criterion' && x.p);

  // Duplicates: two story criteria with the same normalized check.
  const seen = new Map<string, Requirement>();
  for (const { r, p } of stories) {
    const first = seen.get(p!.signature);
    if (first) {
      findings.push({
        type: 'duplicate',
        severity: 'low',
        title: `${r.sourceId} duplicates ${first.sourceId}`,
        detail: `Both criteria express the same check (${p!.signature}).`,
        recommendation: `Merge ${r.id} (${r.sourceId}) into ${first.id} (${first.sourceId}) so the rule is tested once and traced to one criterion.`,
        affected: [first.id, r.id],
        evidence: [
          { source: `${first.provenance.source}${first.provenance.path}`, quote: first.text },
          { source: `${r.provenance.source}${r.provenance.path}`, quote: r.text },
        ],
        proposedAction: { type: 'merge', from: r.id, into: first.id },
      });
    } else seen.set(p!.signature, r);
  }

  // Conflicts: stated maximums that disagree with the data dictionary.
  for (const { r, p } of parsed) {
    if (p?.check !== 'max-inclusive') continue;
    const field = allFields(inputs.dictionary).find((f) => f.path === p.fields[0]);
    const max = p.parameters.max as number;
    if (field?.def.max !== undefined && field.def.max !== max) {
      const code = inputs.sourceRefs?.references.find((x) => x.ruleId === 'BR-002' && x.layer === 'apex');
      findings.push({
        type: 'conflict',
        severity: 'medium',
        title: `${r.sourceId} allows ${max} customers; data dictionary and code allow ${field.def.max}`,
        detail: `${r.sourceId} says up to ${max}; ${field.entity}.${field.name} has max ${field.def.max}${code ? ` and ${code.file}:${code.line} rejects values above ${field.def.max}` : ''}.`,
        recommendation: `Confirm the maximum with the product owner. Until then treat ${field.def.max} as the tested upper bound and record ${r.sourceId} as needing clarification.`,
        affected: [r.id],
        evidence: [
          { source: `${r.provenance.source}${r.provenance.path}`, quote: r.text },
          { source: `fixtures/inputs/data-dictionary.json#/entities/${field.entity}/fields/${field.name}`, quote: `"max": ${field.def.max}` },
        ],
        proposedAction: { type: 'clarify', requirementId: r.id, note: `Tested upper bound is ${field.def.max} (dictionary and code); ${max} pending product-owner confirmation.` },
      });
    }
  }

  // Missing: catalogue rules with no story acceptance criterion.
  for (const { r, p } of parsed.filter((x) => x.r.kind === 'business-rule-statement')) {
    if (!p) continue;
    if (!stories.some((s) => s.p!.signature === p.signature)) {
      findings.push({
        type: 'missing',
        severity: 'high',
        title: `${r.sourceId} has no acceptance criterion in ${inputs.story.id}`,
        detail: `The business-rules catalogue requires "${r.text}" but no ${inputs.story.id} acceptance criterion states it.`,
        recommendation: `Add an acceptance criterion to ${inputs.story.id}: "${r.text}"`,
        affected: [r.id],
        evidence: [{ source: `${r.provenance.source}${r.provenance.path}`, quote: r.text }],
        proposedAction: { type: 'add-requirement', text: r.text, ruleId: r.sourceId },
      });
    }
  }

  // Code-only behavior: rule markers in source with no requirement.
  const catalogued = new Set(inputs.rules.rules.map((r) => r.id));
  const codeOnly = new Map<string, { file: string; line: number; code: string }>();
  for (const ref of inputs.sourceRefs?.references ?? []) if (!catalogued.has(ref.ruleId) && !codeOnly.has(ref.ruleId)) codeOnly.set(ref.ruleId, ref);
  for (const [ruleId, ref] of codeOnly) {
    const text = CODE_ONLY_RULE_TEXT[ruleId] ?? `Behavior ${ref.code} implemented in code.`;
    findings.push({
      type: 'code-only',
      severity: 'medium',
      title: `Code enforces ${ref.code} (${ruleId}) but no requirement states it`,
      detail: `${ref.file}:${ref.line} rejects requests with ${ref.code}. Neither ${inputs.story.id} nor the rules catalogue mention it.`,
      recommendation: `Confirm the behavior and, if intended, add it to the rules catalogue as "${text}" so it is tested and traced.`,
      affected: [],
      evidence: [{ source: `${ref.file}:${ref.line}`, quote: `@rule ${ruleId} ${ref.code}` }],
      proposedAction: { type: 'include-code-rule', ruleId, text },
    });
  }

  return findings.map((f, i) => ({ id: `RF-${pad(i + 1)}`, ...f }));
}

/**
 * Applies human decisions to the draft requirements to produce the baseline. Only findings a
 * human accepted change anything; the agent's recommendation alone never does.
 */
export function applyDecisions(requirements: Requirement[], findings: ReviewFinding[], decisions: FindingDecision[], approver: string): { baseline: Requirement[]; acceptedCodeRules: { ruleId: string; text: string }[] } {
  const baseline = requirements.map((r) => ({ ...r, status: 'baselined' as Requirement['status'] }));
  const acceptedCodeRules: { ruleId: string; text: string }[] = [];
  let next = requirements.length + 1;
  for (const f of findings) {
    const d = decisions.find((x) => x.findingId === f.id);
    if (d?.decision !== 'accept') continue;
    const a = f.proposedAction;
    if (a.type === 'merge') {
      const r = baseline.find((x) => x.id === a.from)!;
      r.status = 'merged';
      r.mergedInto = a.into;
      r.reviewerNote = `Merged into ${a.into} by ${approver} (${f.id}).`;
    } else if (a.type === 'clarify') {
      const r = baseline.find((x) => x.id === a.requirementId)!;
      r.reviewerNote = `${a.note} Accepted by ${approver} (${f.id}).`;
    } else if (a.type === 'add-requirement') {
      baseline.push({
        id: `REQ-${pad(next++)}`,
        kind: 'reviewer-added',
        text: a.text,
        sourceId: `${f.id}:${a.ruleId}`,
        version: 1,
        status: 'baselined',
        reviewerNote: `Added by ${approver} from review finding ${f.id}.`,
        provenance: { source: 'human-review', path: `#/findings/${f.id}`, sha256: '', recordedFrom: `Reviewer decision by ${approver}` },
        contentHash: '',
      });
    } else if (a.type === 'include-code-rule') {
      acceptedCodeRules.push({ ruleId: a.ruleId, text: a.text });
      baseline.push({
        id: `REQ-${pad(next++)}`,
        kind: 'reviewer-added',
        text: a.text,
        sourceId: `${f.id}:${a.ruleId}`,
        version: 1,
        status: 'baselined',
        reviewerNote: `Code-only behavior accepted as a requirement by ${approver} (${f.id}).`,
        provenance: { source: 'human-review', path: `#/findings/${f.id}`, sha256: '', recordedFrom: `Reviewer decision by ${approver}` },
        contentHash: '',
      });
    }
  }
  return { baseline, acceptedCodeRules };
}
