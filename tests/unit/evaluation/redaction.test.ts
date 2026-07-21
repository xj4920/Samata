import { describe, expect, it } from 'vitest';
import { containsLikelySecret, hashTelemetryIdentifier, redactText, redactValue } from '../../../src/evaluation/redaction.js';

describe('evaluation redaction', () => {
  it('redacts common contact and credential patterns', () => {
    const input = '联系 test@example.com 或 13800138000，Authorization: secret-value，访问 https://x.test?a=1&token=abc123';
    const output = redactText(input);
    expect(output).not.toContain('test@example.com');
    expect(output).not.toContain('13800138000');
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('token=abc123');
  });

  it('redacts configured business terms and nested sensitive fields', () => {
    const output = redactValue({ customer: 'ACME', api_key: 'top-secret', nested: ['ACME'] }, { terms: ['ACME'] });
    expect(output).toEqual({ customer: '[REDACTED_TERM]', api_key: '[REDACTED_FIELD]', nested: ['[REDACTED_TERM]'] });
  });

  it('creates stable irreversible telemetry hashes', () => {
    expect(hashTelemetryIdentifier('turn-1')).toBe(hashTelemetryIdentifier('turn-1'));
    expect(hashTelemetryIdentifier('turn-1')).not.toContain('turn-1');
  });

  it('detects likely unredacted secrets', () => {
    expect(containsLikelySecret('token=raw-secret')).toBe(true);
    expect(containsLikelySecret('{"token":"raw-secret"}')).toBe(true);
    expect(containsLikelySecret('普通文本')).toBe(false);
  });
});
