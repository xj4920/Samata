import { createHash } from 'crypto';

const SENSITIVE_KEY_RE = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|session[_-]?id|access[_-]?key|private[_-]?key)/i;

const TEXT_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[REDACTED_EMAIL]' },
  { pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, replacement: '[REDACTED_PHONE]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  { pattern: /\b(?:sk|pk|ak)[-_][A-Za-z0-9_-]{12,}\b/g, replacement: '[REDACTED_KEY]' },
  {
    pattern: /([?&](?:token|key|api_key|apikey|access_token|secret|password)=)[^&#\s]+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
    replacement: '[REDACTED_CREDENTIAL]',
  },
];

export interface RedactionOptions {
  terms?: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactText(input: string, options: RedactionOptions = {}): string {
  let output = input;
  for (const rule of TEXT_RULES) output = output.replace(rule.pattern, rule.replacement);
  for (const term of options.terms ?? []) {
    const normalized = term.trim();
    if (!normalized) continue;
    output = output.replace(new RegExp(escapeRegExp(normalized), 'gi'), '[REDACTED_TERM]');
  }
  return output;
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  if (typeof value === 'string') return redactText(value, options);
  if (Array.isArray(value)) return value.map(item => redactValue(item, options));
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? '[REDACTED_FIELD]' : redactValue(nested, options),
    ]),
  );
}

export function hashTelemetryIdentifier(value: string): string {
  return createHash('sha256').update(`samata-scenario-eval-v1:${value}`).digest('hex').slice(0, 24);
}

export function containsLikelySecret(input: string): boolean {
  const detectionRules = [
    ...TEXT_RULES.slice(0, -1),
    {
      pattern: /\b(?:password|passwd|secret|token|api[_-]?key|authorization)[ \t]*[:=][ \t]*(?!["']?\[REDACTED)[^\s,;]+/gi,
      replacement: '',
    },
    {
      pattern: /["'](?:password|passwd|secret|token|api[_-]?key|authorization)["'][ \t]*:[ \t]*(?!["']?\[REDACTED)["'][^"']+/gi,
      replacement: '',
    },
  ];
  return detectionRules.some(rule => {
    rule.pattern.lastIndex = 0;
    const found = rule.pattern.test(input);
    rule.pattern.lastIndex = 0;
    return found;
  });
}
