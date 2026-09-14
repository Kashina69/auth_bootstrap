import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { Throttle, ThrottlerException, ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { GraphqlThrottlerGuard } from './graphql-throttler.guard.js';

const TTL = 60_000;
const LIMIT = 2;

class AuthResolver {
  login(): void {}
  roles(): void {}
}
Throttle({ default: { limit: 1, ttl: TTL } })(
  AuthResolver.prototype,
  'login',
  Object.getOwnPropertyDescriptor(AuthResolver.prototype, 'login')!,
);

class AuthController {
  login(): void {}
}

/** The real Nest host of the shape `@nestjs/apollo` builds: root, args, context, info. */
function graphqlContext(handler: () => void, ip: string): ExecutionContextHost {
  const host = new ExecutionContextHost(
    [undefined, {}, { req: { ip, headers: {} } }, {}],
    AuthResolver,
    handler,
  );
  host.setType('graphql');
  return host;
}

function httpContext(handler: () => void, ip: string): ExecutionContextHost {
  const response = { header: () => undefined };
  return new ExecutionContextHost([{ ip, headers: {} }, response], AuthController, handler);
}

async function createGuard(): Promise<GraphqlThrottlerGuard> {
  const guard = new GraphqlThrottlerGuard(
    [{ ttl: TTL, limit: LIMIT }],
    new ThrottlerStorageService(),
    new Reflector(),
  );
  await guard.onModuleInit();
  return guard;
}

describe('GraphqlThrottlerGuard', () => {
  it('throttles a GraphQL field rather than reading req.ip off the resolver root', async () => {
    const guard = await createGuard();
    await expect(guard.canActivate(graphqlContext(AuthResolver.prototype.roles, '203.0.113.7'))).resolves.toBe(
      true,
    );
  });

  it('is the fix for the stock guard, which fails on every GraphQL field', async () => {
    const stock = new ThrottlerGuard(
      [{ ttl: TTL, limit: LIMIT }],
      new ThrottlerStorageService(),
      new Reflector(),
    );
    await stock.onModuleInit();
    await expect(stock.canActivate(graphqlContext(AuthResolver.prototype.roles, '203.0.113.8'))).rejects.toThrow(
      "Cannot read properties of undefined (reading 'ip')",
    );
  });

  it('buckets GraphQL callers by the request ip, as REST does', async () => {
    const guard = await createGuard();
    const first = graphqlContext(AuthResolver.prototype.roles, '203.0.113.9');
    await expect(guard.canActivate(first)).resolves.toBe(true);
    await expect(guard.canActivate(first)).resolves.toBe(true);

    const other = graphqlContext(AuthResolver.prototype.roles, '203.0.113.10');
    await expect(guard.canActivate(other)).resolves.toBe(true);
    await expect(guard.canActivate(first)).rejects.toThrow(ThrottlerException);
  });

  it('honours the per-operation @Throttle() ceiling on a resolver method', async () => {
    const guard = await createGuard();
    const login = graphqlContext(AuthResolver.prototype.login, '203.0.113.11');
    await expect(guard.canActivate(login)).resolves.toBe(true);
    await expect(guard.canActivate(login)).rejects.toThrow(ThrottlerException);
  });

  it('leaves HTTP contexts to the base implementation', async () => {
    const guard = await createGuard();
    const context = httpContext(AuthController.prototype.login, '203.0.113.12');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).rejects.toThrow(ThrottlerException);
  });
});
