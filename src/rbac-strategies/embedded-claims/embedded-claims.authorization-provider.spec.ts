import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config.service.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { EmbeddedClaimsAuthorizationProvider } from './embedded-claims.authorization-provider.js';

const provider = new EmbeddedClaimsAuthorizationProvider({} as AppConfig);

function userWith(claims: Partial<AuthenticatedUser>): AuthenticatedUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    isActive: true,
    isEmailVerified: true,
    ...claims,
  };
}

describe('EmbeddedClaimsAuthorizationProvider', () => {
  it('reads the roles and permissions baked into the identity', async () => {
    const user = userWith({ roles: ['admin'], permissions: ['manage:all'] });

    await expect(provider.getContext(user)).resolves.toEqual({
      roles: ['admin'],
      permissions: ['manage:all'],
    });
  });

  it('is a pure in-memory read — the same identity always yields the same context', async () => {
    const user = userWith({ roles: ['editor'], permissions: ['update:Post'] });

    await expect(provider.getContext(user)).resolves.toEqual(await provider.getContext(user));
  });

  it('denies by default when the identity carries no claims (a pre-claims token or session)', async () => {
    await expect(provider.getContext(userWith({}))).resolves.toEqual({ roles: [], permissions: [] });
  });

  it('denies by default when the claims are not arrays (a hand-rolled request.user)', async () => {
    const user = { ...userWith({}), roles: 'admin', permissions: 'manage:all' } as unknown as AuthenticatedUser;

    await expect(provider.getContext(user)).resolves.toEqual({ roles: [], permissions: [] });
  });

  it('drops non-string entries rather than trusting the array shape', async () => {
    const user = {
      ...userWith({}),
      roles: ['admin', 42, null],
      permissions: ['manage:all', { action: 'update' }],
    } as unknown as AuthenticatedUser;

    await expect(provider.getContext(user)).resolves.toEqual({
      roles: ['admin'],
      permissions: ['manage:all'],
    });
  });

  it('returns empty claims for a null identity instead of throwing', async () => {
    await expect(provider.getContext(null as unknown as AuthenticatedUser)).resolves.toEqual({
      roles: [],
      permissions: [],
    });
  });

  it('invalidate() is a no-op — claims live in the caller token, not in a server-side store', async () => {
    await expect(provider.invalidate('user-1')).resolves.toBeUndefined();
  });
});
