import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { TransformInterceptor } from './transform.interceptor.js';

const handler = <T>(value: T): CallHandler<T> => ({ handle: () => of(value) });

function httpContext(url: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ url }),
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function graphqlContext(): ExecutionContext {
  return {
    getType: () => 'graphql',
    switchToHttp: () => ({ getRequest: () => undefined, getResponse: () => undefined }),
  } as unknown as ExecutionContext;
}

describe('TransformInterceptor', () => {
  it('wraps an HTTP payload in the { data, meta } envelope the client unwraps', async () => {
    const interceptor = new TransformInterceptor<string>();

    const result = await firstValueFrom(interceptor.intercept(httpContext('/auth/me'), handler('payload')));

    // `../client/src/lib/api.ts` reads `body.data` — a bare value here breaks every caller.
    expect(result).toEqual({
      data: 'payload',
      meta: { timestamp: expect.any(String), path: '/auth/me' },
    });
  });

  it('carries exactly the two envelope keys the client knows about', async () => {
    const interceptor = new TransformInterceptor();
    const result = (await firstValueFrom(
      interceptor.intercept(httpContext('/auth/me'), handler({ id: 'user-1' })),
    )) as Record<string, unknown>;

    expect(Object.keys(result)).toEqual(['data', 'meta']);
    expect(Object.keys(result.meta as object)).toEqual(['timestamp', 'path']);
  });

  it('stamps a parseable ISO-8601 timestamp', async () => {
    const interceptor = new TransformInterceptor();
    const result = (await firstValueFrom(interceptor.intercept(httpContext('/health'), handler(null)))) as {
      meta: { timestamp: string };
    };

    expect(new Date(result.meta.timestamp).toISOString()).toBe(result.meta.timestamp);
  });

  it('reports the request url, not a hard-coded one', async () => {
    const interceptor = new TransformInterceptor();

    const result = (await firstValueFrom(
      interceptor.intercept(httpContext('/rbac-admin/roles'), handler([])),
    )) as { meta: { path: string } };

    expect(result.meta.path).toBe('/rbac-admin/roles');
  });

  it('passes a GraphQL execution through untouched, envelope and all', async () => {
    // GraphQL owns `{ data, errors }`; a second wrapper would break the response spec.
    const interceptor = new TransformInterceptor();
    const graphqlResult = { data: { me: { id: 'user-1' } } };

    const result = await firstValueFrom(interceptor.intercept(graphqlContext(), handler(graphqlResult)));

    expect(result).toBe(graphqlResult);
  });

  it('still wraps a falsy payload rather than dropping the envelope', async () => {
    const interceptor = new TransformInterceptor();

    const result = await firstValueFrom(interceptor.intercept(httpContext('/logout'), handler(undefined)));

    expect(result).toEqual({ data: undefined, meta: { timestamp: expect.any(String), path: '/logout' } });
  });
});
