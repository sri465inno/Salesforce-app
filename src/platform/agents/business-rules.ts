/**
 * Business Rules Agent: turns rule statements into structured, testable rules (validation,
 * constraint, decision, outcome) and links every rule to its source requirement(s) and code.
 */
import { Inputs, allFields } from '../inputs';
import { parseStatement } from '../statements';
import { BusinessRule, Requirement, RuleCheck, RuleKind } from '../types';

export const AGENT = 'Business Rules Agent';

const KIND: Record<RuleCheck['type'], RuleKind> = {
  'date-order': 'constraint',
  'min-exclusive': 'validation',
  reference: 'validation',
  'approved-value': 'validation',
  'generated-output': 'outcome',
  'required-fields': 'validation',
  availability: 'decision',
  format: 'validation',
  authorization: 'decision',
};

const CRITICALITY: Record<RuleCheck['type'], BusinessRule['criticality']> = {
  'generated-output': 'critical',
  'approved-value': 'critical',
  authorization: 'high',
  'date-order': 'high',
  'min-exclusive': 'high',
  reference: 'high',
  'required-fields': 'high',
  availability: 'high',
  format: 'medium',
};

export function extractRules(requirements: Requirement[], inputs: Inputs, acceptedCodeRules: { ruleId: string; text: string }[] = []): BusinessRule[] {
  const active = requirements.filter((r) => r.status !== 'merged' && r.status !== 'excluded');
  const parsedReqs = active.map((r) => ({ r, p: parseStatement(r.text, inputs.dictionary) }));
  const fields = allFields(inputs.dictionary);
  const statements = [
    ...inputs.rules.rules.map((r) => ({ ...r, origin: 'catalogue' as const })),
    ...acceptedCodeRules.map((r) => ({ id: r.ruleId, text: r.text, origin: 'code-only (reviewer accepted)' as const })),
  ];

  return statements.map((stmt) => {
    const p = parseStatement(stmt.text, inputs.dictionary);
    if (!p || p.check === 'max-inclusive') throw new Error(`${AGENT}: cannot interpret ${stmt.id} "${stmt.text}"`);
    const type = p.check;
    const refs = (inputs.sourceRefs?.references ?? []).filter((x) => x.ruleId === stmt.id);
    const errorCode = refs.find((x) => x.code !== 'CONFIRMATION_NUMBER')?.code ?? null;
    const field = fields.find((f) => f.path === p.fields[0]);
    const parameters: Record<string, unknown> = { ...p.parameters };
    if (type === 'min-exclusive' && field?.def.max !== undefined) parameters.max = field.def.max;
    if (type === 'approved-value') parameters.approvedValues = field?.def.approvedValues ?? [];
    if (type === 'reference') parameters.validValues = inputs.dictionary.referenceData.locations.filter((l) => l.active).map((l) => l.locationId);
    if (type === 'generated-output') parameters.pattern = fields.find((f) => f.name === 'confirmationNumber')?.def.pattern;

    const sourceRequirements = new Set<string>();
    for (const { r, p: rp } of parsedReqs) {
      if (r.kind === 'business-rule-statement' && r.sourceId === stmt.id) sourceRequirements.add(r.id);
      else if (r.kind === 'reviewer-added' && r.sourceId.endsWith(`:${stmt.id}`)) sourceRequirements.add(r.id);
      else if (rp && rp.signature === p.signature) sourceRequirements.add(r.id);
      else if (rp?.check === 'max-inclusive' && type === 'min-exclusive' && rp.fields[0] === p.fields[0]) sourceRequirements.add(r.id);
      else if (r.kind === 'story' && type === 'generated-output') sourceRequirements.add(r.id);
    }
    const entity = field?.entity ?? (p.fields[0].startsWith('customer.') ? 'Customer' : 'Reservation');
    return {
      id: stmt.id,
      text: stmt.text,
      kind: KIND[type],
      entity,
      condition: describeCondition(type, p.fields, parameters),
      expectedOutcome: errorCode ? `createReservation returns success=false with error ${errorCode}` : 'createReservation returns success=true, status CONFIRMED and a confirmation number',
      check: { type, fields: p.fields, errorCode, parameters },
      sourceRequirements: [...sourceRequirements].sort(),
      codeReferences: refs.map((x) => ({ file: x.file, line: x.line, symbol: x.symbol })),
      origin: stmt.origin,
      criticality: CRITICALITY[type],
    };
  });
}

function describeCondition(type: RuleCheck['type'], f: string[], params: Record<string, unknown>): string {
  switch (type) {
    case 'date-order':
      return `${f[0]} < ${f[1]}`;
    case 'min-exclusive':
      return `${f[0]} > ${params.threshold}${params.max !== undefined ? ` and ${f[0]} <= ${params.max} (data dictionary)` : ''}`;
    case 'reference':
      return `${f[0]} in active locations (${(params.validValues as string[]).join(', ')})`;
    case 'approved-value':
      return `${f[0]} in (${(params.approvedValues as string[]).join(', ')})`;
    case 'generated-output':
      return `on success, ${f[0]} matches ${params.pattern}`;
    case 'required-fields':
      return `${f.join(', ')} are non-blank`;
    case 'availability':
      return `remaining capacity for ${f[0]} at the location over [${f[1]}, ${f[2]}) > 0`;
    case 'format':
      return `${f[0]} is a syntactically valid value`;
    case 'authorization':
      return 'mock payment gateway returns AUTHORIZED for the synthetic token';
  }
}
