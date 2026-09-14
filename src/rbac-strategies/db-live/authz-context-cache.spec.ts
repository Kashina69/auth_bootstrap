import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { AuthzContext } from '../../rbac-core/index.js';
import {
  AUTHZ_CONTEXT_TTL_SECONDS,
  authzContextCacheKey,
  clearCachedContext,
  readCachedContext,
  toAuthzContext,
  writeCachedContext,
} from './authz-context-cache.js';

const ADMIN: AuthzContext = { roles: ['admin'], permissions: ['manage:all'] };
const USER: AuthzContext = { roles: ['user'], permissions: ['read:Post'] };

interface FakeRedis extends Redis {
  entries: Map<string, string>;
  ttls: Array<{ key: string; seconds: number }>;
}

function createFakeRedis(): FakeRedis {
  const entries = new Map<string, string>();
  const ttls: Array<{ key: string; seconds: number }> = [];
  return {
    entries,
    ttls,
    get: (key: string) => Promise.resolve(entries.get(key) ?? null),
    set: (key: string, value: string, _ex: string, seconds: number) => {
      entries.set(key, value);
      ttls.push({ key, seconds });
      return Promise.resolve('OK');
    },
    del: (key: string) => Promise.resolve(entries.delete(key) ? 1 : 0),
  } as unknown as FakeRedis;
}

function createBrokenRedis(): Redis {
  const fail = () => Promise.reject(new Error('redis is down'));
  return { get: fail, set: fail, del: fail } as unknown as Redis;
}

describe('authzContextCacheKey', () => {
  it('namespaces the entry so it cannot collide with another Redis user', () => {
    expect(authzContextCacheKey('user-1')).toBe('rbac:context:user-1');
  });

  it('gives every distinct user a distinct key', () => {
    const ids = ['user-1', 'user-2', 'user-10', 'user-1 ', 'user', 'User-1', ''];

    expect(new Set(ids.map(authzContextCacheKey)).size).toBe(ids.length);
  });
});

describe('a cached context', () => {
  it('is never served to a different user', async () => {
    // The whole cache-integrity invariant: a key that lost the user id would hand
    // `admin`'s permissions to whoever asked next.
    const redis = createFakeRedis();
    await writeCachedContext(redis, 'admin-user', ADMIN);
    await writeCachedContext(redis, 'regular-user', USER);

    expect(await readCachedContext(redis, 'admin-user')).toEqual(ADMIN);
    expect(await readCachedContext(redis, 'regular-user')).toEqual(USER);
  });

  it('is unknowable to a user who never had one written', async () => {
    const redis = createFakeRedis();
    await writeCachedContext(redis, 'admin-user', ADMIN);

    expect(await readCachedContext(redis, 'attacker')).toBeNull();
  });

  it('round-trips through the cache', async () => {
    const redis = createFakeRedis();
    await writeCachedContext(redis, 'user-1', ADMIN);

    expect(await readCachedContext(redis, 'user-1')).toEqual(ADMIN);
  });

  it('is written with the documented TTL, so a revoked role cannot outlive it for long', async () => {
    const redis = createFakeRedis();
    await writeCachedContext(redis, 'user-1', ADMIN);

    expect(redis.ttls).toEqual([
      { key: authzContextCacheKey('user-1'), seconds: AUTHZ_CONTEXT_TTL_SECONDS },
    ]);
  });

  it('expires within seconds, not minutes', () => {
    expect(AUTHZ_CONTEXT_TTL_SECONDS).toBe(5);
  });
});

describe('clearCachedContext', () => {
  it('drops only the addressed user, so one admin change cannot evict everyone', async () => {
    const redis = createFakeRedis();
    await writeCachedContext(redis, 'user-1', ADMIN);
    await writeCachedContext(redis, 'user-2', USER);

    await clearCachedContext(redis, 'user-1');

    expect(await readCachedContext(redis, 'user-1')).toBeNull();
    expect(await readCachedContext(redis, 'user-2')).toEqual(USER);
  });
});

describe('when Redis is unreachable', () => {
  it('answers "no cached context" instead of failing the request', async () => {
    // The DB is the authority; an unreachable cache must degrade to a DB read.
    expect(await readCachedContext(createBrokenRedis(), 'user-1')).toBeNull();
  });

  it('does not fail a request the DB already answered', async () => {
    await expect(writeCachedContext(createBrokenRedis(), 'user-1', ADMIN)).resolves.toBeUndefined();
    await expect(clearCachedContext(createBrokenRedis(), 'user-1')).resolves.toBeUndefined();
  });
});

describe('an unusable cache entry', () => {
  it('is treated as a miss when the JSON is corrupt', async () => {
    const redis = createFakeRedis();
    redis.entries.set(authzContextCacheKey('user-1'), '{"roles":[');

    expect(await readCachedContext(redis, 'user-1')).toBeNull();
  });

  it('is treated as a miss when the shape is wrong', async () => {
    const redis = createFakeRedis();
    redis.entries.set(authzContextCacheKey('user-1'), JSON.stringify({ roles: 'admin', permissions: [] }));

    expect(await readCachedContext(redis, 'user-1')).toBeNull();
  });
});

describe('toAuthzContext', () => {
  it('distinguishes "nothing" from "something unusable"', () => {
    expect(toAuthzContext(null)).toBeNull();
    expect(toAuthzContext('admin')).toBeNull();
    expect(toAuthzContext({ roles: ['admin'] })).toBeNull();
    expect(toAuthzContext({ roles: ['admin', 1], permissions: [] })).toBeNull();
  });

  it('returns a copy, so a caller mutating the result cannot corrupt the stored value', () => {
    const stored = { roles: ['admin'], permissions: ['manage:all'] };

    const context = toAuthzContext(stored);
    context?.roles.push('user');

    expect(stored.roles).toEqual(['admin']);
  });

  it('accepts an empty context as a valid answer', () => {
    expect(toAuthzContext({ roles: [], permissions: [] })).toEqual({ roles: [], permissions: [] });
  });
});
