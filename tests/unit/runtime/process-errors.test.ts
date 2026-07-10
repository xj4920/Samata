import { describe, expect, it } from 'vitest';
import { isBrokenPipeError } from '../../../src/runtime/process-errors.js';

describe('process error helpers', () => {
  it('recognizes EPIPE errors from broken sockets or pipes', () => {
    const err = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
      errno: -32,
      syscall: 'write',
    });

    expect(isBrokenPipeError(err)).toBe(true);
  });

  it('does not treat unrelated process errors as broken pipes', () => {
    const err = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
      errno: -13,
    });

    expect(isBrokenPipeError(err)).toBe(false);
  });
});
