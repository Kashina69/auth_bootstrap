import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, AuthzContext } from '../../rbac-core/index.js';
import type { IAuthorizationProvider } from '../../rbac-strategies/authorization-provider.interface.js';
import { AuthzService } from './authz.service.js';

/** A `db-live` identity: no claims of its own — everything comes from the provider. */
const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  isActive: true,
  isEmailVerified: true,
};

function createProvider(context: AuthzContext): IAuthorizationProvider & { getContext: ReturnType<typeof vi.fn> } {
  return {
    getContext: vi.fn().mockResolvedValue(context),
    invalidate: vi.fn(),
  } as unknown as IAuthorizationProvider & { getContext: ReturnType<typeof vi.fn> };
}

describe('AuthzService', () => {
  describe('describeIdentity', () => {
    it('fills in roles and permissions the caller token does not carry (the db-live case)', async () => {
      const service = new AuthzService(createProvider({ roles: ['editor'], permissions: ['update:Post'] }));

      await expect(service.describeIdentity(USER)).resolves.toEqual({
        ...USER,
        roles: ['editor'],
        permissions: ['update:Post'],
      });
    });

    it('reports empty grants rather than omitting the fields when the provider yields none', async () => {
      const service = new AuthzService(createProvider({ roles: [], permissions: [] }));

      await expect(service.describeIdentity(USER)).resolves.toEqual({ ...USER, roles: [], permissions: [] });
    });

    it('never leaks a claim the provider did not return', async () => {
      const service = new AuthzService(createProvider({ roles: [], permissions: [] }));
      const withStaleClaims = { ...USER, roles: ['admin'], permissions: ['manage:all'] };

      await expect(service.describeIdentity(withStaleClaims)).resolves.toEqual({
        ...USER,
        roles: [],
        permissions: [],
      });
    });
  });

  describe('checkPermission', () => {
    it('allows an exactly granted permission', async () => {
      const service = new AuthzService(createProvider({ roles: [], permissions: ['update:Post'] }));

      await expect(service.checkPermission(USER, 'update', 'Post')).resolves.toEqual({ allowed: true });
    });

    it('allows any action under manage:all', async () => {
      const service = new AuthzService(createProvider({ roles: ['admin'], permissions: ['manage:all'] }));

      await expect(service.checkPermission(USER, 'delete', 'Post')).resolves.toEqual({ allowed: true });
    });

    it('allows any action under a subject-wide manage grant', async () => {
      const service = new AuthzService(createProvider({ roles: [], permissions: ['manage:Post'] }));

      await expect(service.checkPermission(USER, 'delete', 'Post')).resolves.toEqual({ allowed: true });
    });

    it('denies by default when the grant is absent', async () => {
      const service = new AuthzService(createProvider({ roles: [], permissions: ['read:Post'] }));

      await expect(service.checkPermission(USER, 'update', 'Post')).resolves.toEqual({ allowed: false });
    });

    it('matches the subject case-sensitively', async () => {
      const service = new AuthzService(createProvider({ roles: [], permissions: ['update:Post'] }));

      await expect(service.checkPermission(USER, 'update', 'post')).resolves.toEqual({ allowed: false });
    });

    it('asks the provider every time — a revoked role is never answered from a stale copy', async () => {
      const provider = createProvider({ roles: [], permissions: [] });
      const service = new AuthzService(provider);

      await service.checkPermission(USER, 'update', 'Post');
      await service.checkPermission(USER, 'update', 'Post');

      expect(provider.getContext).toHaveBeenCalledTimes(2);
    });
  });
});
