import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { LoggingInterceptor, redactSensitiveFields } from './logging.interceptor.js';

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

describe('LoggingInterceptor', () => {
  const handler: CallHandler = { handle: () => of('resolved') };

  it('passes a GraphQL execution through untouched instead of reading a missing request', async () => {
    const interceptor = new LoggingInterceptor();

    await expect(firstValueFrom(interceptor.intercept(graphqlContext(), handler))).resolves.toBe('resolved');
  });

  it('still logs and forwards an HTTP execution', async () => {
    const interceptor = new LoggingInterceptor();

    await expect(firstValueFrom(interceptor.intercept(httpContext(), handler))).resolves.toBe('resolved');
  });
});

/** `switchToHttp()` on a GraphQL context yields no request — reading `.method` off it is the crash. */
function graphqlContext(): ExecutionContext {
  return {
    getType: () => 'graphql',
    switchToHttp: () => ({ getRequest: () => undefined, getResponse: () => undefined }),
  } as unknown as ExecutionContext;
}

function httpContext(): ExecutionContext {
  const request = { method: 'GET', url: '/health', body: undefined };
  const response = { statusCode: 200 };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}
