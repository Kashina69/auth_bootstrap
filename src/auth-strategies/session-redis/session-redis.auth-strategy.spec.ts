import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/app-config.service.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import type { RequestMeta } from '../auth-strategy.interface.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';
import { SESSION_KEY_PREFIX, SESSION_TTL_SECONDS } from './session-store.js';
import { SessionRedisAuthStrategy } from './session-redis.auth-strategy.js';

const META: RequestMeta = { userAgent: 'vitest', ip: '127.0.0.1' };

const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  isActive: true,
  isEmailVerified: true,
  roles: ['editor'],
  permissions: ['update:Post'],
};

/** The key the store must actually use — a raw session id must never appear in Redis. */
function storedKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${createHash('sha256').update(sessionId).digest('hex')}`;
}

interface FakeRedis extends Redis {
  entries: Map<string, string>;
  expires: string[];
}

function createFakeRedis(): FakeRedis {
  const entries = new Map<string, string>();
  const expires: string[] = [];
  return {
    entries,
    expires,
    async get(key: string) {
      return entries.get(key) ?? null;
    },
    async set(key: string, value: string) {
      entries.set(key, value);
      return 'OK';
    },
    async expire(key: string) {
      expires.push(key);
      return 1;
    },
    async del(key: string) {
      return entries.delete(key) ? 1 : 0;
    },
  } as unknown as FakeRedis;
}

function createStrategy(redis: Redis): SessionRedisAuthStrategy {
  return new SessionRedisAuthStrategy(redis, {} as AppConfig);
}

function requestWithCookie(sessionId?: string): FastifyRequest {
  return {
    headers: sessionId ? { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}` } : {},
  } as unknown as FastifyRequest;
}

describe('SessionRedisAuthStrategy', () => {
  describe('login', () => {
    it('stores a session and returns the session id as the credential', async () => {
      const redis = createFakeRedis();
      const result = await createStrategy(redis).login(USER, META);

      expect(result.user).toEqual(USER);
      expect(result.refreshToken).toEqual(expect.any(String));
      expect(redis.entries.size).toBe(1);
      expect(redis.entries.get(storedKey(result.refreshToken as string))).toBeDefined();
    });

    it('never stores the raw session id as a Redis key', async () => {
      const redis = createFakeRedis();
      const result = await createStrategy(redis).login(USER, META);

      expect([...redis.entries.keys()]).not.toContain(result.refreshToken);
      expect(redis.entries.get(storedKey(result.refreshToken as string))).toBeDefined();
    });

    it('stores the user snapshot so validateRequest can rebuild the identity without a DB', async () => {
      const redis = createFakeRedis();
      const result = await createStrategy(redis).login(USER, META);
      const record = JSON.parse(redis.entries.get(storedKey(result.refreshToken as string)) ?? '{}');

      expect(record.user).toEqual(USER);
      expect(record.device).toEqual(META);
    });

    it('mints a distinct id per login', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const first = await strategy.login(USER, META);
      const second = await strategy.login(USER, META);

      expect(first.refreshToken).not.toEqual(second.refreshToken);
    });

    it('reports the expiry the session store records', async () => {
      const redis = createFakeRedis();
      const result = await createStrategy(redis).login(USER, META);
      const record = JSON.parse(redis.entries.get(storedKey(result.refreshToken as string)) ?? '{}');

      expect(result.expiresAt).toBe(record.expiresAt);
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('validateRequest', () => {
    it('resolves the user from the session cookie alone', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const { refreshToken } = await strategy.login(USER, META);

      await expect(strategy.validateRequest(requestWithCookie(refreshToken as string))).resolves.toEqual(USER);
    });

    it('returns null when no cookie is present', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      await strategy.login(USER, META);

      await expect(strategy.validateRequest(requestWithCookie())).resolves.toBeNull();
    });

    it('returns null for an unknown session id', async () => {
      await expect(createStrategy(createFakeRedis()).validateRequest(requestWithCookie('not-a-session'))).resolves.toBeNull();
    });

    it('fails closed when Redis throws — a Redis outage is not a 500 and not an identity', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const { refreshToken } = await strategy.login(USER, META);
      redis.get = vi.fn().mockRejectedValue(new Error('redis down'));

      await expect(strategy.validateRequest(requestWithCookie(refreshToken as string))).resolves.toBeNull();
    });

    it('returns null for a corrupt session record rather than throwing', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const { refreshToken } = await strategy.login(USER, META);
      redis.entries.set(storedKey(refreshToken as string), '{not json');

      await expect(strategy.validateRequest(requestWithCookie(refreshToken as string))).resolves.toBeNull();
    });

    it('never reads a user id from the request itself', async () => {
      const redis = createFakeRedis();
      const req = requestWithCookie() as FastifyRequest & { user?: unknown };
      req.user = { id: 'admin', roles: ['admin'] };

      await expect(createStrategy(redis).validateRequest(req)).resolves.toBeNull();
    });
  });

  describe('refresh', () => {
    it('extends the session TTL and returns a fresh expiry', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const { refreshToken, expiresAt } = await strategy.login(USER, META);

      const refreshed = await strategy.refresh(refreshToken, META);

      expect(redis.expires).toEqual([storedKey(refreshToken as string)]);
      expect(refreshed.user).toEqual(USER);
      expect(new Date(refreshed.expiresAt).getTime()).toBeGreaterThanOrEqual(new Date(expiresAt).getTime());
    });

    it('reports the refreshing device in the result', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const { refreshToken } = await strategy.login(USER, META);
      const moved: RequestMeta = { userAgent: 'other', ip: '10.0.0.1' };

      await strategy.refresh(refreshToken, moved);
      const record = JSON.parse(redis.entries.get(storedKey(refreshToken as string)) ?? '{}');

      // Only the Redis TTL moves on refresh (`extendSession`); the stored blob keeps the
      // login-time device, so `validateRequest` reports where the session was created.
      expect(record.device).toEqual(META);
    });

    it('rejects an unknown session', async () => {
      await expect(createStrategy(createFakeRedis()).refresh('not-a-session', META)).rejects.toThrow(
        new UnauthorizedException('Session is invalid or expired'),
      );
    });

    it('rejects a malformed reference with the same message as an unknown one', async () => {
      const strategy = createStrategy(createFakeRedis());

      await expect(strategy.refresh(undefined, META)).rejects.toThrow(UnauthorizedException);
      await expect(strategy.refresh('', META)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('deletes the session when given the raw session id', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const { refreshToken } = await strategy.login(USER, META);

      await strategy.logout(USER.id, refreshToken);

      expect(redis.entries.size).toBe(0);
    });

    it('deletes the session when given the platform request (the shape the controller passes)', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const { refreshToken } = await strategy.login(USER, META);

      await strategy.logout(USER.id, requestWithCookie(refreshToken as string));

      expect(redis.entries.size).toBe(0);
    });

    it('leaves another user session alone', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      const { refreshToken } = await strategy.login(USER, META);

      await strategy.logout('someone-else', requestWithCookie(refreshToken as string));

      expect(redis.entries.size).toBe(1);
    });

    it('no-ops on a reference it cannot interpret instead of throwing', async () => {
      const redis = createFakeRedis();
      const strategy = createStrategy(redis);
      await strategy.login(USER, META);

      await expect(strategy.logout(USER.id, 42)).resolves.toBeUndefined();
      await expect(strategy.logout(USER.id, undefined)).resolves.toBeUndefined();
      await expect(strategy.logout(USER.id, requestWithCookie())).resolves.toBeUndefined();
      expect(redis.entries.size).toBe(1);
    });
  });

  it('session TTL matches the 30-day refresh-token TTL it mirrors', () => {
    expect(SESSION_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
  });
});
