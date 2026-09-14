import { UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter.js';

describe('HttpExceptionFilter', () => {
  it('rethrows a GraphQL exception instead of writing an HTTP response', () => {
    const exception = new UnauthorizedException();

    expect(() => new HttpExceptionFilter().catch(exception, graphqlHost())).toThrow(exception);
  });

  it('still writes the REST error envelope', () => {
    const sent: Array<{ status: number; body: unknown }> = [];
    const host = httpHost((status, body) => sent.push({ status, body }));

    new HttpExceptionFilter().catch(new UnauthorizedException(), host);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.status).toBe(401);
    expect(sent[0]?.body).toMatchObject({ statusCode: 401, error: 'UnauthorizedException', path: '/rbac-admin/roles' });
  });
});

/** `switchToHttp()` on a GraphQL host yields no request — reading `.method` off it is the crash. */
function graphqlHost(): ArgumentsHost {
  return {
    getType: () => 'graphql',
    switchToHttp: () => ({ getRequest: () => undefined, getResponse: () => undefined }),
  } as unknown as ArgumentsHost;
}

function httpHost(send: (status: number, body: unknown) => void): ArgumentsHost {
  const request = { method: 'GET', url: '/rbac-admin/roles' };
  const response = {
    code: (status: number) => ({
      send: (body: unknown) => {
        send(status, body);
      },
    }),
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
}
