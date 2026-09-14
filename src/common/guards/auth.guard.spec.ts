import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { IAuthStrategy } from '../../auth-strategies/auth-strategy.interface.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { Public } from '../decorators/public.decorator.js';
import { AuthGuard } from './auth.guard.js';

const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  isActive: true,
  isEmailVerified: true,
  roles: ['editor'],
  permissions: ['update:Post'],
};

class ProtectedController {
  read(): void {}
  open(): void {}
}
Public()(ProtectedController.prototype.open);

function createStrategy(user: AuthenticatedUser | null): IAuthStrategy & { validateRequest: ReturnType<typeof vi.fn> } {
  return {
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    validateRequest: vi.fn().mockResolvedValue(user),
  } as unknown as IAuthStrategy & { validateRequest: ReturnType<typeof vi.fn> };
}

function createHttpContext(handler: () => unknown, request: Record<string, unknown> = {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => ProtectedController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * `GqlExecutionContext.create(context).getContext()` reads the third argument slot, which is
 * where `@nestjs/graphql` places the GraphQL context. Both accessors are provided because the
 * implementation may read either.
 */
function createGraphqlContext(handler: () => unknown, graphqlContext: unknown): ExecutionContext {
  // Four slots, as a real resolver receives them — `GqlExecutionContext` treats a 3-element
  // array as a reference resolver and shifts the context out of the slot it reads.
  const args = [null, null, graphqlContext, null];
  return {
    getHandler: () => handler,
    getClass: () => ProtectedController,
    getType: () => 'graphql',
    getArgs: () => args,
    getArgByIndex: (index: number) => args[index],
    switchToHttp: () => ({ getRequest: () => undefined }),
  } as unknown as ExecutionContext;
}

function createGuard(strategy: IAuthStrategy): AuthGuard {
  return new AuthGuard(strategy, new Reflector());
}

describe('AuthGuard', () => {
  it('attaches the resolved user to the request so RbacGuard and @CurrentUser() can read it', async () => {
    const request: { user?: AuthenticatedUser } = {};
    const guard = createGuard(createStrategy(USER));

    await expect(guard.canActivate(createHttpContext(ProtectedController.prototype.read, request))).resolves.toBe(true);
    expect(request.user).toEqual(USER);
  });

  it('rejects with UnauthorizedException when the strategy resolves no user', async () => {
    const guard = createGuard(createStrategy(null));

    await expect(guard.canActivate(createHttpContext(ProtectedController.prototype.read))).rejects.toThrow(
      new UnauthorizedException(),
    );
  });

  it('does not attach a user when it rejects', async () => {
    const request: { user?: AuthenticatedUser } = {};
    const guard = createGuard(createStrategy(null));

    await guard.canActivate(createHttpContext(ProtectedController.prototype.read, request)).catch(() => undefined);
    expect(request.user).toBeUndefined();
  });

  it('lets a @Public() route through without consulting the strategy', async () => {
    const strategy = createStrategy(null);
    const guard = createGuard(strategy);

    await expect(guard.canActivate(createHttpContext(ProtectedController.prototype.open))).resolves.toBe(true);
    expect(strategy.validateRequest).not.toHaveBeenCalled();
  });

  it('still authenticates a protected route on the same controller', async () => {
    const strategy = createStrategy(USER);
    const guard = createGuard(strategy);

    await expect(guard.canActivate(createHttpContext(ProtectedController.prototype.read))).resolves.toBe(true);
    expect(strategy.validateRequest).toHaveBeenCalledTimes(1);
  });

  it('reads the identity from the GraphQL context rather than switchToHttp()', async () => {
    const request: { user?: AuthenticatedUser } = {};
    const guard = createGuard(createStrategy(USER));

    await expect(
      guard.canActivate(createGraphqlContext(ProtectedController.prototype.read, { req: request })),
    ).resolves.toBe(true);
    expect(request.user).toEqual(USER);
  });

  it('asserts no identity on the GraphQL transport when the strategy resolves none', async () => {
    const guard = createGuard(createStrategy(null));

    await expect(
      guard.canActivate(createGraphqlContext(ProtectedController.prototype.read, { req: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('leaves a @Public() GraphQL operation open too', async () => {
    const guard = createGuard(createStrategy(null));

    await expect(
      guard.canActivate(createGraphqlContext(ProtectedController.prototype.open, { req: {} })),
    ).resolves.toBe(true);
  });

  it('propagates a strategy failure instead of interpreting it as an identity', async () => {
    const strategy = createStrategy(USER);
    strategy.validateRequest.mockRejectedValue(new Error('boom'));
    const guard = createGuard(strategy);

    await expect(guard.canActivate(createHttpContext(ProtectedController.prototype.read))).rejects.toThrow('boom');
  });

  it('passes the platform request through to the strategy so it can read its own credential', async () => {
    const request = { headers: { authorization: 'Bearer token' } } as unknown as FastifyRequest;
    const strategy = createStrategy(USER);
    const guard = createGuard(strategy);

    await guard.canActivate(createHttpContext(ProtectedController.prototype.read, request as unknown as Record<string, unknown>));
    expect(strategy.validateRequest).toHaveBeenCalledWith(request);
  });
});
