import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { CurrentUser } from './current-user.decorator.js';

const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  isActive: true,
  isEmailVerified: true,
};

/** Controllers and resolvers are the same shape here; the decorator branches on the context type. */
class AuthController {
  me(_user: AuthenticatedUser | undefined): void {}
}

CurrentUser()(AuthController.prototype, 'me', 0);

interface RegisteredParam {
  index: number;
  factory: (data: unknown, context: ExecutionContext) => AuthenticatedUser | undefined;
}

/**
 * The factory Nest registered for the `@CurrentUser()` parameter. A parameter decorator
 * returns a registration closure, not the factory — the only place the real function lives
 * is the route-args metadata, which is where the router reads it back from.
 */
function currentUserFactory(): RegisteredParam['factory'] {
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, AuthController, 'me') as
    | Record<string, RegisteredParam>
    | undefined;
  const entry = Object.values(metadata ?? {}).find((param) => param.index === 0);
  if (!entry) throw new Error('@CurrentUser() registered no custom parameter');
  return entry.factory;
}

/** Exactly what `getContextFactory` builds for an HTTP handler: [req, res, next]. */
function httpContext(user: AuthenticatedUser | undefined): ExecutionContext {
  const host = new ExecutionContextHost(
    [{ user }, {}, {}],
    AuthController,
    AuthController.prototype.me,
  );
  host.setType('http');
  return host;
}

/** Exactly what `@nestjs/apollo` builds for a resolver: [root, args, context, info]. */
function graphqlContext(user: AuthenticatedUser | undefined): ExecutionContext {
  const host = new ExecutionContextHost(
    [undefined, {}, { req: { user } }, {}],
    AuthController,
    AuthController.prototype.me,
  );
  host.setType('graphql');
  return host;
}

describe('@CurrentUser()', () => {
  it('registers itself as a parameter decorator on the annotated argument', () => {
    expect(currentUserFactory()).toBeTypeOf('function');
  });

  it('injects the user AuthGuard attached to an HTTP request', () => {
    expect(currentUserFactory()(undefined, httpContext(USER))).toBe(USER);
  });

  it('injects the user on a GraphQL resolver too, off the execution context rather than the HTTP request', () => {
    expect(currentUserFactory()(undefined, graphqlContext(USER))).toBe(USER);
  });

  it('resolves to undefined on an unauthenticated request instead of throwing', () => {
    expect(currentUserFactory()(undefined, httpContext(undefined))).toBeUndefined();
    expect(currentUserFactory()(undefined, graphqlContext(undefined))).toBeUndefined();
  });
});
