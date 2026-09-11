import { describe, expect, it } from 'vitest';
import { redactSensitiveFields } from './logging.interceptor.js';

describe('redactSensitiveFields', () => {
  it('redacts every password-shaped field named in implementation.spec.md §1', () => {
    const body = {
      email: 'user@example.com',
      password: 'hunter2',
      newPassword: 'hunter3',
      confirmPassword: 'hunter3',
    };

    expect(redactSensitiveFields(body)).toEqual({
      email: 'user@example.com',
      password: '[REDACTED]',
      newPassword: '[REDACTED]',
      confirmPassword: '[REDACTED]',
    });
  });

  it('leaves non-password fields untouched', () => {
    expect(redactSensitiveFields({ refreshToken: 'opaque' })).toEqual({ refreshToken: 'opaque' });
  });

  it('passes non-object payloads through unchanged', () => {
    expect(redactSensitiveFields(undefined)).toBeUndefined();
    expect(redactSensitiveFields('raw')).toBe('raw');
  });
});
