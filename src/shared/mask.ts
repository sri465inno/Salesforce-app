/**
 * Masking applied to everything the platform writes: logs, evidence, defects, reports and
 * exports. Data is synthetic, but the controls are exercised as if it were not.
 */
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const TOKEN = /\btok_[A-Za-z0-9_]{4,}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi;

export const SENSITIVE_KEYS = ['email', 'paymentToken', 'firstName', 'lastName', 'password', 'secret', 'apiKey', 'authorization'];

export function maskToken(token: string): string {
  return token.length <= 8 ? 'tok_****' : `tok_****${token.slice(-4)}`;
}

export function maskEmail(email: string): string {
  return email.replace(EMAIL, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

export function maskName(name: string): string {
  return name ? `${name[0]}***` : name;
}

export function maskText(text: string): string {
  return text
    .replace(BEARER, '$1 ****')
    .replace(TOKEN, (t) => maskToken(t))
    .replace(EMAIL, (_m, first: string, domain: string) => `${first}***@${domain}`)
    .replace(CARD, (m) => (luhn(m.replace(/\D/g, '')) ? '[CARD-NUMBER-REDACTED]' : m));
}

export function maskValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (key === 'paymentToken' || key === 'authorization' || key === 'password' || key === 'secret' || key === 'apiKey') return maskToken(value);
  if (key === 'email') return maskEmail(value);
  if (key === 'firstName' || key === 'lastName') return maskName(value);
  return maskText(value);
}

/** Deep-clone with sensitive values masked. */
export function maskDeep<T>(value: T): T {
  const walk = (v: unknown, key: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    }
    return SENSITIVE_KEYS.includes(key) ? maskValue(key, v) : typeof v === 'string' ? maskText(v) : v;
  };
  return walk(value, '') as T;
}

export function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
