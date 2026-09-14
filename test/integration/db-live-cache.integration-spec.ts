import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { can } from '../../src/rbac-core/index.js';
import type { AuthenticatedUser } from '../../src/rbac-core/index.js';
import {
  AUTHZ_CONTEXT_TTL_SECONDS,
  authzContextCacheKey,
  EMPTY_AUTHZ_CONTEXT,
} from '../../src/rbac-strategies/db-live/authz-context-cache.js';
import { DbLiveAuthorizationProvider } from '../../src/rbac-strategies/db-live/db-live.authorization-provider.js';
import { PrismaUserRepository } from '../../src/database/repositories/prisma-user.repository.js';
import {
  appConfig,
  clearRedisKeys,
  createPrismaClient,
  createRedisClient,
  migrateDatabase,
  truncateAll,
} from './support/live-services.js';

describe('db-live authorization cache against real Redis and Postgres', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let provider: DbLiveAuthorizationProvider;
  let userId: string;
  let otherUserId: string;

  function identity(id: string): AuthenticatedUser {
    return { id, email: 'cached@example.com', isActive: true, isEmailVerified: true, roles: [], permissions: [] };
  }

  /** Grants a permission through a role — the shape an admin mutation leaves behind. */
  async function grantRole(id: string, roleName: string, permissionName: string): Promise<string> {
    const [action, subject] = permissionName.split(':');
    const permission = await prisma.permission.create({ data: { action, subject, name: permissionName } });
    const role = await prisma.role.create({ data: { name: roleName } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.userRole.create({ data: { userId: id, roleId: role.id } });
    return role.id;
  }

  beforeAll(async () => {
    await migrateDatabase();
    prisma = createPrismaClient();
    redis = createRedisClient();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await clearRedisKeys(redis);
    const first = await prisma.user.create({ data: { email: 'cached@example.com', passwordHash: 'x' } });
    const second = await prisma.user.create({ data: { email: 'other@example.com', passwordHash: 'x' } });
    userId = first.id;
    otherUserId = second.id;
    provider = new DbLiveAuthorizationProvider(new PrismaUserRepository(prisma), redis, appConfig());
  });

  afterAll(async () => {
    await clearRedisKeys(redis);
    await redis.quit();
    await prisma.$disconnect();
  });

  it('caches the resolved context under a short TTL', async () => {
    await grantRole(userId, 'editor', 'update:Post');

    await provider.getContext(identity(userId));

    const ttl = await redis.ttl(authzContextCacheKey(userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(AUTHZ_CONTEXT_TTL_SECONDS);
  });

  it('serves the warm entry instead of the database', async () => {
    await grantRole(userId, 'editor', 'update:Post');
    await provider.getContext(identity(userId));

    // Change the database without invalidating: a provider that re-read it would see this.
    await grantRole(userId, 'admin', 'delete:Post');
    const cached = await provider.getContext(identity(userId));

    expect(cached.roles).toEqual(['editor']);
    expect(await redis.exists(authzContextCacheKey(userId))).toBe(1);
  });

  it('makes an admin change visible immediately once invalidated', async () => {
    await grantRole(userId, 'editor', 'update:Post');
    await expect(provider.getContext(identity(userId))).resolves.toMatchObject({ roles: ['editor'] });

    await grantRole(userId, 'admin', 'delete:Post');
    await provider.invalidate(userId);

    expect(await redis.exists(authzContextCacheKey(userId))).toBe(0);
    const fresh = await provider.getContext(identity(userId));
    expect(fresh.roles.sort()).toEqual(['admin', 'editor']);
    expect(fresh.permissions.sort()).toEqual(['delete:Post', 'update:Post']);
  });

  it('revokes a permission on the very next check after invalidate', async () => {
    const roleId = await grantRole(userId, 'editor', 'update:Post');
    await provider.getContext(identity(userId));
    expect(can(await provider.getContext(identity(userId)), 'update', 'Post')).toBe(true);

    await prisma.rolePermission.deleteMany({ where: { roleId } });
    await provider.invalidate(userId);

    expect(can(await provider.getContext(identity(userId)), 'update', 'Post')).toBe(false);
  });

  it('invalidating one user leaves another user cached context untouched', async () => {
    await grantRole(userId, 'editor', 'update:Post');
    await grantRole(otherUserId, 'viewer', 'read:Post');
    await provider.getContext(identity(userId));
    await provider.getContext(identity(otherUserId));

    await provider.invalidate(userId);

    expect(await redis.exists(authzContextCacheKey(userId))).toBe(0);
    expect(await redis.exists(authzContextCacheKey(otherUserId))).toBe(1);
    await expect(provider.getContext(identity(otherUserId))).resolves.toMatchObject({ roles: ['viewer'] });
  });

  it('denies by default for a user with no grants', async () => {
    await expect(provider.getContext(identity(userId))).resolves.toEqual(EMPTY_AUTHZ_CONTEXT);
    expect(can(await provider.getContext(identity(userId)), 'update', 'Post')).toBe(false);
  });

  it('answers an unusable user id with the empty context and never touches Redis', async () => {
    await expect(provider.getContext(identity(''))).resolves.toEqual(EMPTY_AUTHZ_CONTEXT);
    await expect(provider.getContext({ id: undefined } as unknown as AuthenticatedUser)).resolves.toEqual(
      EMPTY_AUTHZ_CONTEXT,
    );
    await expect(provider.invalidate('')).resolves.toBeUndefined();

    expect(await redis.keys('rbac:context:*')).toEqual([]);
  });
});
