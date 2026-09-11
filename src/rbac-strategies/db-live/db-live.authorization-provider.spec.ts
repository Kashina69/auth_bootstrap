import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/app-config.service.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { DbLiveAuthorizationProvider } from './db-live.authorization-provider.js';
import { authzContextCacheKey } from './authz-context-cache.js';

const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  isActive: true,
  isEmailVerified: true,
};

function createFakeRedis(): Redis & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async get(key: string) {
      return entries.get(key) ?? null;
    },
    async set(key: string, value: string) {
      entries.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      return entries.delete(key) ? 1 : 0;
    },
  } as unknown as Redis & { entries: Map<string, string> };
}

function createUsers(
  findRolesAndPermissions: UserRepository['findRolesAndPermissions'],
): UserRepository {
  return { findRolesAndPermissions } as unknown as UserRepository;
}

function createProvider(users: UserRepository, redis: Redis): DbLiveAuthorizationProvider {
  return new DbLiveAuthorizationProvider(users, redis, {} as AppConfig);
}

describe('DbLiveAuthorizationProvider', () => {
  it('reads roles and permissions from the repository on a cache miss', async () => {
    const findRolesAndPermissions = vi.fn().mockResolvedValue({
      roles: ['admin'],
      permissions: ['manage:all'],
    });
    const provider = createProvider(createUsers(findRolesAndPermissions), createFakeRedis());

    await expect(provider.getContext(USER)).resolves.toEqual({
      roles: ['admin'],
      permissions: ['manage:all'],
    });
    expect(findRolesAndPermissions).toHaveBeenCalledWith('user-1');
  });

  it('serves the second call from the cache without touching the repository', async () => {
    const findRolesAndPermissions = vi.fn().mockResolvedValue({
      roles: ['editor'],
      permissions: ['update:Post'],
    });
    const provider = createProvider(createUsers(findRolesAndPermissions), createFakeRedis());

    await provider.getContext(USER);
    await expect(provider.getContext(USER)).resolves.toEqual({
      roles: ['editor'],
      permissions: ['update:Post'],
    });
    expect(findRolesAndPermissions).toHaveBeenCalledTimes(1);
  });

  it('re-reads the DB on the next call after invalidate()', async () => {
    const findRolesAndPermissions = vi
      .fn()
      .mockResolvedValueOnce({ roles: ['admin'], permissions: ['manage:all'] })
      .mockResolvedValueOnce({ roles: [], permissions: [] });
    const provider = createProvider(createUsers(findRolesAndPermissions), createFakeRedis());

    await provider.getContext(USER);
    await provider.invalidate(USER.id);

    await expect(provider.getContext(USER)).resolves.toEqual({ roles: [], permissions: [] });
    expect(findRolesAndPermissions).toHaveBeenCalledTimes(2);
  });

  it('denies by default when the repository throws', async () => {
    const findRolesAndPermissions = vi.fn().mockRejectedValue(new Error('db down'));
    const redis = createFakeRedis();
    const provider = createProvider(createUsers(findRolesAndPermissions), redis);

    await expect(provider.getContext(USER)).resolves.toEqual({ roles: [], permissions: [] });
    expect(redis.entries.has(authzContextCacheKey(USER.id))).toBe(false);
  });

  it('denies by default for a user with no usable id', async () => {
    const findRolesAndPermissions = vi.fn();
    const provider = createProvider(createUsers(findRolesAndPermissions), createFakeRedis());

    await expect(provider.getContext({ ...USER, id: '' })).resolves.toEqual({
      roles: [],
      permissions: [],
    });
    expect(findRolesAndPermissions).not.toHaveBeenCalled();
  });

  it('denies by default on a malformed repository result', async () => {
    const findRolesAndPermissions = vi.fn().mockResolvedValue({ roles: 'admin' });
    const provider = createProvider(createUsers(findRolesAndPermissions), createFakeRedis());

    await expect(provider.getContext(USER)).resolves.toEqual({ roles: [], permissions: [] });
  });

  it('falls back to the DB when the cache read fails, and still answers', async () => {
    const findRolesAndPermissions = vi.fn().mockResolvedValue({
      roles: ['admin'],
      permissions: ['manage:all'],
    });
    const redis = createFakeRedis();
    redis.get = vi.fn().mockRejectedValue(new Error('redis down'));
    const provider = createProvider(createUsers(findRolesAndPermissions), redis);

    await expect(provider.getContext(USER)).resolves.toEqual({
      roles: ['admin'],
      permissions: ['manage:all'],
    });
  });

  it('ignores a corrupt cache entry and denies only if the DB also yields nothing', async () => {
    const findRolesAndPermissions = vi.fn().mockRejectedValue(new Error('db down'));
    const redis = createFakeRedis();
    redis.entries.set(authzContextCacheKey(USER.id), '{not json');
    const provider = createProvider(createUsers(findRolesAndPermissions), redis);

    await expect(provider.getContext(USER)).resolves.toEqual({ roles: [], permissions: [] });
    expect(findRolesAndPermissions).toHaveBeenCalledTimes(1);
  });

  it('serves a valid cached entry without a DB call', async () => {
    const findRolesAndPermissions = vi.fn();
    const redis = createFakeRedis();
    redis.entries.set(
      authzContextCacheKey(USER.id),
      JSON.stringify({ roles: ['admin'], permissions: ['manage:all'] }),
    );
    const provider = createProvider(createUsers(findRolesAndPermissions), redis);

    await expect(provider.getContext(USER)).resolves.toEqual({
      roles: ['admin'],
      permissions: ['manage:all'],
    });
    expect(findRolesAndPermissions).not.toHaveBeenCalled();
  });

  it('does not throw and deletes nothing for an unusable id', async () => {
    const redis = createFakeRedis();
    const provider = createProvider(createUsers(vi.fn()), redis);

    await expect(provider.invalidate('')).resolves.toBeUndefined();
    expect(redis.entries.size).toBe(0);
  });

  it('survives an unreachable Redis on invalidate()', async () => {
    const redis = createFakeRedis();
    redis.del = vi.fn().mockRejectedValue(new Error('redis down'));
    const provider = createProvider(createUsers(vi.fn()), redis);

    await expect(provider.invalidate(USER.id)).resolves.toBeUndefined();
  });
});
