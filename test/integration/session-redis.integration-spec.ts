import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../../src/auth-strategies/session-redis/session-cookie.js';
import { SESSION_KEY_PREFIX, SESSION_TTL_SECONDS } from '../../src/auth-strategies/session-redis/session-store.js';
import { SessionRedisAuthStrategy } from '../../src/auth-strategies/session-redis/session-redis.auth-strategy.js';
import type { RequestMeta } from '../../src/auth-strategies/auth-strategy.interface.js';
import type { AuthenticatedUser } from '../../src/rbac-core/index.js';
import {
  allSuiteKeys,
  appConfig,
  clearRedisKeys,
  createRedisClient,
  unreachableRedisClient,
} from './support/live-services.js';

const META: RequestMeta = { userAgent: 'vitest', ip: '127.0.0.1' };

const USER: AuthenticatedUser = {
  id: 'c1a2b3c4-0000-4000-8000-000000000010',
  email: 'session@example.com',
  isActive: true,
  isEmailVerified: true,
  roles: ['editor'],
  permissions: ['update:Post'],
};

function hashedKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${createHash('sha256').update(sessionId).digest('hex')}`;
}

function requestWithCookie(sessionId?: string): FastifyRequest {
  return {
    headers: sessionId === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}` },
  } as unknown as FastifyRequest;
}

describe('SessionRedisAuthStrategy over real Redis', () => {
  let redis: Redis;
  let strategy: SessionRedisAuthStrategy;

  beforeAll(() => {
    redis = createRedisClient();
    strategy = new SessionRedisAuthStrategy(redis, appConfig());
  });

  beforeEach(async () => {
    await clearRedisKeys(redis);
  });

  afterAll(async () => {
    await clearRedisKeys(redis);
    await redis.quit();
  });

  it('issues a session whose Redis key carries the 30-day expiry', async () => {
    const { refreshToken } = await strategy.login(USER, META);

    const ttl = await redis.ttl(hashedKey(refreshToken as string));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
  });

  it('authenticates a request from the cookie alone', async () => {
    const { refreshToken } = await strategy.login(USER, META);

    await expect(strategy.validateRequest(requestWithCookie(refreshToken as string))).resolves.toEqual(USER);
  });

  it('stores no raw session id anywhere in Redis', async () => {
    const { refreshToken } = await strategy.login(USER, META);

    // `includes`, not `toContain`: an exact match would miss a `session:<raw id>` key because
    // every key carries the namespace prefix.
    expect((await allSuiteKeys(redis)).some((key) => key.includes(refreshToken as string))).toBe(false);
  });

  it('slides the expiry on refresh and keeps the same session alive', async () => {
    const { refreshToken } = await strategy.login(USER, META);
    await redis.expire(hashedKey(refreshToken as string), 120);

    const refreshed = await strategy.refresh(refreshToken, META);

    const ttl = await redis.ttl(hashedKey(refreshToken as string));
    expect(ttl).toBeGreaterThan(120);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
    // Refresh rotates nothing under this strategy: the id the client holds keeps working.
    expect(refreshed.refreshToken).toEqual(refreshToken);
    await expect(strategy.validateRequest(requestWithCookie(refreshToken as string))).resolves.toEqual(USER);
  });

  it('stops a session working as soon as logout deletes its key', async () => {
    const { refreshToken } = await strategy.login(USER, META);
    const req = requestWithCookie(refreshToken as string);

    await strategy.logout(USER.id, refreshToken);

    expect(await redis.exists(hashedKey(refreshToken as string))).toBe(0);
    await expect(strategy.validateRequest(req)).resolves.toBeNull();
    await expect(strategy.refresh(refreshToken, META)).rejects.toThrow('Session is invalid or expired');
  });

  it('refuses to revoke a session belonging to another user', async () => {
    const { refreshToken } = await strategy.login(USER, META);
    const req = requestWithCookie(refreshToken as string);

    await strategy.logout('someone-else', req);

    expect(await redis.exists(hashedKey(refreshToken as string))).toBe(1);
    await expect(strategy.validateRequest(req)).resolves.toEqual(USER);
  });

  it('fails closed when Redis is unreachable: no identity, and no throw out of the guard', async () => {
    const { refreshToken } = await strategy.login(USER, META);
    const req = requestWithCookie(refreshToken as string);
    const dead = unreachableRedisClient();

    try {
      const outage = new SessionRedisAuthStrategy(dead, appConfig());
      await expect(outage.validateRequest(req)).resolves.toBeNull();
    } finally {
      dead.disconnect();
    }
  });

  /**
   * `refresh` and `validateRequest` must agree about what a dead Redis means. They did not:
   * an outage produced a clean 401 on every guarded route but surfaced a raw ioredis error
   * (a 500 through the exception filter) on refresh. This pins the fixed behaviour — a 401 —
   * so the two paths cannot drift apart again. Open item S19 in WAVE-LOG.md, fixed here.
   */
  it('fails closed with a 401 when Redis is unreachable during refresh, matching validateRequest', async () => {
    const { refreshToken } = await strategy.login(USER, META);
    const dead = unreachableRedisClient();

    try {
      const outage = new SessionRedisAuthStrategy(dead, appConfig());
      await expect(outage.refresh(refreshToken, META)).rejects.toThrow(UnauthorizedException);
      await expect(outage.refresh(refreshToken, META)).rejects.toThrow(
        'Session is invalid or expired',
      );
    } finally {
      dead.disconnect();
    }
  });
});
