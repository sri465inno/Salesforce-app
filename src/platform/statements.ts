/**
 * Deterministic statement parser shared by the Review, Business Rules and Test Lab stages.
 * It maps a plain-language requirement to a normalized check signature using the data
 * dictionary aliases. No language model is involved.
 */
import { allFields, DataDictionary } from './inputs';
import { RuleCheck } from './types';

export interface ParsedStatement {
  check: RuleCheck['type'] | 'max-inclusive';
  fields: string[];
  parameters: Record<string, unknown>;
  signature: string;
}

const WORD_NUMBERS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, ten: 10, twelve: 12 };
const num = (s: string) => (s in WORD_NUMBERS ? WORD_NUMBERS[s] : Number(s));

/** Resolve a phrase to a field path using the longest matching dictionary alias. */
export function resolveField(phrase: string, dictionary: DataDictionary): string | null {
  const p = phrase.toLowerCase();
  let best: { path: string; len: number } | null = null;
  for (const f of allFields(dictionary)) {
    for (const alias of [...(f.def.aliases ?? []), f.name.toLowerCase()]) {
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(p) && (!best || alias.length > best.len)) best = { path: f.path, len: alias.length };
    }
  }
  if (!best && /confirmation number/.test(p)) return 'confirmationNumber';
  return best?.path ?? null;
}

function sig(check: string, fields: string[], parameters: Record<string, unknown> = {}): ParsedStatement {
  const params = Object.keys(parameters).length ? `:${JSON.stringify(parameters)}` : '';
  return { check: check as ParsedStatement['check'], fields, parameters, signature: `${check}:${fields.join(',')}${params}` };
}

export function parseStatement(text: string, dictionary: DataDictionary): ParsedStatement | null {
  const t = text.toLowerCase().replace(/\.$/, '');
  let m: RegExpExecArray | null;
  if ((m = /(.+?) must be earlier than (.+)$/.exec(t))) {
    const a = resolveField(m[1], dictionary);
    const b = resolveField(m[2], dictionary);
    return a && b ? sig('date-order', [a, b]) : null;
  }
  if ((m = /(.+?) must be (?:greater|more) than (zero|\d+)/.exec(t))) {
    const f = resolveField(m[1], dictionary);
    return f ? sig('min-exclusive', [f], { threshold: num(m[2]) }) : null;
  }
  if ((m = /(.+?) must be at least (one|two|\d+)/.exec(t))) {
    const f = resolveField(m[1], dictionary);
    return f ? sig('min-exclusive', [f], { threshold: num(m[2]) - 1 }) : null;
  }
  if ((m = /(?:up to|at most|no more than) (\d+|twelve|ten) (.+)$/.exec(t))) {
    const f = resolveField(m[2], dictionary);
    return f ? sig('max-inclusive', [f], { max: num(m[1]) }) : null;
  }
  if ((m = /a valid (.+?) is required/.exec(t))) {
    const f = resolveField(m[1], dictionary);
    return f ? sig('reference', [f]) : null;
  }
  if ((m = /an approved (.+?) is required/.exec(t))) {
    const f = resolveField(m[1], dictionary);
    return f ? sig('approved-value', [f]) : null;
  }
  if (/confirmation number must be generated/.test(t)) return sig('generated-output', ['confirmationNumber']);
  if ((m = /(.+?) must be available for the selected dates/.exec(t))) {
    const f = resolveField(m[1], dictionary);
    return f ? sig('availability', [f, 'startDate', 'endDate']) : null;
  }
  if ((m = /required (\w+) fields must be supplied/.exec(t))) {
    const entity = Object.keys(dictionary.entities).find((e) => e.toLowerCase() === m![1]);
    if (!entity) return null;
    const fields = Object.entries(dictionary.entities[entity].fields)
      .filter(([, d]) => d.required && d.source === 'user')
      .map(([n]) => `${entity.toLowerCase()}.${n}`)
      .sort();
    return sig('required-fields', fields);
  }
  if ((m = /^(.+?) (?:is|are) required$/.exec(t))) {
    const fields = m[1]
      .split(/,|\band\b/)
      .map((part) => resolveField(part.trim(), dictionary))
      .filter((f): f is string => !!f);
    return fields.length ? sig('required-fields', [...new Set(fields)].sort()) : null;
  }
  if ((m = /(.+?) must be (?:a )?valid(?: format)?$/.exec(t))) {
    const f = resolveField(m[1], dictionary);
    return f ? sig('format', [f]) : null;
  }
  if (/payment must be authori[sz]ed/.test(t)) return sig('authorization', ['payment.paymentToken']);
  return null;
}
