import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { Permissions } from '../decorators/permissions.decorator.js';
import { PERMISSIONS_KEY } from '../constants.js';
import type { AuthenticatedUser, AuthzContext } from '../../rbac-core/index.js';
import type { IAuthorizationProvider } from '../../rbac-strategies/authorization-provider.interface.js';
import { RbacGuard } from './rbac.guard.js';

const user: AuthenticatedUser = { id: 'u1', email: 'u@example.com', isActive: true, isEmailVerified: true };
const openHandler = () => undefined;

class PostsController {
  updatePost(): void {}
  listPosts(): void {}
}
Permissions('update:Post')(PostsController.prototype.updatePost);

function createGuard(permissions: string[]): RbacGuard {
  const authz: IAuthorizationProvider = {
    getContext: async (): Promise<AuthzContext> => ({ roles: [], permissions }),
    invalidate: async (): Promise<void> => undefined,
  };
  return new RbacGuard(authz, new Reflector());
}

function createContext(handler: () => unknown, authenticatedUser?: AuthenticatedUser): ExecutionContext {
  const request = { user: authenticatedUser };
  return {
    getHandler: () => handler,
    getClass: () => PostsController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RbacGuard', () => {
  it('allows a route with no @Permissions() metadata', async () => {
    const allowed = await createGuard([]).canActivate(createContext(openHandler));
    expect(allowed).toBe(true);
  });

  it('allows when the resolved context grants the required permission', async () => {
    const guard = createGuard(['update:Post']);
    await expect(guard.canActivate(createContext(PostsController.prototype.updatePost, user))).resolves.toBe(true);
  });

  it('allows any action under manage:all', async () => {
    const guard = createGuard(['manage:all']);
    await expect(guard.canActivate(createContext(PostsController.prototype.updatePost, user))).resolves.toBe(true);
  });

  it('denies by default when the permission is missing', async () => {
    const guard = createGuard(['read:Post']);
    await expect(guard.canActivate(createContext(PostsController.prototype.updatePost, user))).rejects.toThrow(
      new ForbiddenException('Insufficient permissions'),
    );
  });

  it('denies when AuthGuard did not attach a user', async () => {
    const guard = createGuard(['update:Post']);
    await expect(guard.canActivate(createContext(PostsController.prototype.updatePost))).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('@Permissions()', () => {
  it('splits on the first colon only', () => {
    const handler = () => undefined;
    Permissions('update:Sub:Thing')(handler);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([{ action: 'update', subject: 'Sub:Thing' }]);
  });

  it('throws on input without a colon', () => {
    expect(() => Permissions('updatePost')).toThrow(/action:subject/);
  });
});
