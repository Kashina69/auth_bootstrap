import { UnauthorizedException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionRedisAuthStrategy } from '../../src/auth-strategies/session-redis/session-redis.auth-strategy.js';
import { SESSION_COOKIE_NAME } from '../../src/auth-strategies/session-redis/session-cookie.js';
import { LoginAttemptService } from '../../src/common/security/login-attempt.service.js';
import { PasswordService } from '../../src/common/security/password.service.js';
import type { AppConfig } from '../../src/config/app-config.service.js';
import { PrismaRoleRepository } from '../../src/database/repositories/prisma-role.repository.js';
import { PrismaUserRepository } from '../../src/database/repositories/prisma-user.repository.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import type { LoginDto } from '../../src/modules/auth/dto/index.js';
import {
  appConfig,
  clearRedisKeys,
  createPrismaClient,
  createRedisClient,
  loginAttemptsOn,
  LOGIN_ATTEMPTS_PREFIX,
  migrateDatabase,
  truncateAll,
  unreachableRedisClient,
} from './support/live-services.js';

const EMAIL = 'Lockout@Example.com';
const NORMALIZED = 'lockout@example.com';
const KEY = `${LOGIN_ATTEMPTS_PREFIX}${NORMALIZED}`;
const PASSWORD = 'Correct-Horse-Battery-9';
const META = { userAgent: 'vitest', ip: '127.0.0.1' };
const INVALID_CREDENTIALS = 'Invalid email or password';
const LOCK_THRESHOLD = 10;
/** `LoginAttemptService` hardcodes the window; the TTL must never exceed it and never be -1. */
const WINDOW_SECONDS = 15 * 60;

describe('login lockout and credential failures against real Redis and Postgres', () => {
  let redis: Redis;
  let prisma: PrismaClient;
  let passwords: PasswordService;
  let attempts: LoginAttemptService;
  let auth: AuthService;

  async function createAccount(email: string, password: string): Promise<string> {
    const passwordHash = await passwords.hash(password);
    const user = await prisma.user.create({ data: { email, passwordHash } });
    return user.id;
  }

  function loginAs(email: string, password: string): Promise<unknown> {
    const dto = { email, password } as LoginDto;
    return auth.login(dto, META);
  }

  beforeAll(async () => {
    await migrateDatabase();
    prisma = createPrismaClient();
    redis = createRedisClient();
    passwords = new PasswordService();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await clearRedisKeys(redis);
    attempts = loginAttemptsOn(redis);
    auth = new AuthService(
      new PrismaUserRepository(prisma),
      new PrismaRoleRepository(prisma),
      new SessionRedisAuthStrategy(redis, appConfig()),
      passwords,
      attempts,
    );
  });

  afterAll(async () => {
    await clearRedisKeys(redis);
    await redis.quit();
    await prisma.$disconnect();
  });

  describe('LoginAttemptService', () => {
    it('counts under the exact lowercased key and does not lock below the threshold', async () => {
      for (let i = 0; i < LOCK_THRESHOLD - 1; i++) await attempts.recordFailure(EMAIL);

      await expect(attempts.isLocked(EMAIL)).resolves.toBe(false);
      expect(await redis.get(KEY)).toBe(String(LOCK_THRESHOLD - 1));
    });

    it('locks at the threshold', async () => {
      for (let i = 0; i < LOCK_THRESHOLD; i++) await attempts.recordFailure(EMAIL);

      await expect(attempts.isLocked(EMAIL)).resolves.toBe(true);
    });

    it('arms the window expiry in Redis — the lock lifts on its own rather than never', async () => {
      await attempts.recordFailure(EMAIL);

      const ttl = await redis.ttl(KEY);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(WINDOW_SECONDS);
    });

    it('still has the expiry armed once the lock is in force', async () => {
      for (let i = 0; i < LOCK_THRESHOLD; i++) await attempts.recordFailure(EMAIL);

      // A key without an expiry reads -1 here, which is precisely the bug this catches.
      const ttl = await redis.ttl(KEY);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(WINDOW_SECONDS);
    });

    it('releases the lock when the counter is cleared', async () => {
      for (let i = 0; i < LOCK_THRESHOLD; i++) await attempts.recordFailure(EMAIL);

      await attempts.clear(EMAIL);

      expect(await redis.exists(KEY)).toBe(0);
      await expect(attempts.isLocked(EMAIL)).resolves.toBe(false);
    });

    it('mutation check: the unreachable client really is unreachable', async () => {
      // Without this, every fail-open assertion below could be passing because the client is
      // a silent no-op rather than because the service degrades.
      const dead = unreachableRedisClient();
      try {
        await expect(dead.ping()).rejects.toThrow();
      } finally {
        dead.disconnect();
      }
    });

    it('fails OPEN when Redis is unreachable — a dead Redis must not lock everyone out', async () => {
      const dead = unreachableRedisClient();
      try {
        const outage = loginAttemptsOn(dead);

        for (let i = 0; i < LOCK_THRESHOLD + 5; i++) {
          await expect(outage.recordFailure(EMAIL)).resolves.toBe(0);
        }
        await expect(outage.isLocked(EMAIL)).resolves.toBe(false);
        await expect(outage.clear(EMAIL)).resolves.toBeUndefined();
      } finally {
        dead.disconnect();
      }
    });

    it('reports nothing when REDIS_URL is unset, leaving the counter untouched', async () => {
      const unset = new LoginAttemptService({ REDIS_URL: undefined } as AppConfig);

      await attempts.recordFailure(EMAIL);
      await expect(unset.isLocked(EMAIL)).resolves.toBe(false);
      expect(await redis.get(KEY)).toBe('1');
    });
  });

  describe('AuthService credential failures', () => {
    it('locks the account after ten failures and refuses the correct password', async () => {
      await createAccount(NORMALIZED, PASSWORD);
      for (let i = 0; i < LOCK_THRESHOLD; i++) {
        await expect(loginAs(NORMALIZED, 'wrong-password')).rejects.toThrow(INVALID_CREDENTIALS);
      }
      // The tenth failure is what arms the lock; `recordFailure` runs before the throw.
      await expect(attempts.isLocked(NORMALIZED)).resolves.toBe(true);

      await expect(loginAs(NORMALIZED, PASSWORD)).rejects.toThrow(INVALID_CREDENTIALS);
      expect(await redis.ttl(KEY)).toBeGreaterThan(0);
    });

    it('answers a wrong password, an unknown address and a locked account with one identical message', async () => {
      await createAccount(NORMALIZED, PASSWORD);

      const messages: string[] = [];
      for (const attempt of [
        () => loginAs(NORMALIZED, 'wrong-password'),
        () => loginAs('nobody@example.com', 'wrong-password'),
      ]) {
        messages.push(await rejectionMessage(attempt));
      }
      for (let i = 0; i < LOCK_THRESHOLD; i++) await attempts.recordFailure(NORMALIZED);
      messages.push(await rejectionMessage(() => loginAs(NORMALIZED, PASSWORD)));

      expect(messages).toEqual([INVALID_CREDENTIALS, INVALID_CREDENTIALS, INVALID_CREDENTIALS]);
      expect(new Set(messages).size).toBe(1);
    });

    it('clears the failure counter on a successful login', async () => {
      await createAccount(NORMALIZED, PASSWORD);
      for (let i = 0; i < LOCK_THRESHOLD - 1; i++) await attempts.recordFailure(NORMALIZED);

      await loginAs(NORMALIZED, PASSWORD);

      expect(await redis.exists(KEY)).toBe(0);
    });

    it('refuses a deactivated account with the same message as a bad password', async () => {
      await createAccount(NORMALIZED, PASSWORD);
      await prisma.user.update({ where: { email: NORMALIZED }, data: { isActive: false } });

      expect(await rejectionMessage(() => loginAs(NORMALIZED, PASSWORD))).toBe(INVALID_CREDENTIALS);
    });

    it('does not lock anyone out while Redis is unreachable — a correct password still logs in', async () => {
      await createAccount(NORMALIZED, PASSWORD);
      const dead = unreachableRedisClient();
      try {
        auth = new AuthService(
          new PrismaUserRepository(prisma),
          new PrismaRoleRepository(prisma),
          new SessionRedisAuthStrategy(redis, appConfig()),
          passwords,
          loginAttemptsOn(dead),
        );

        for (let i = 0; i < LOCK_THRESHOLD + 5; i++) {
          await expect(loginAs(NORMALIZED, 'wrong-password')).rejects.toThrow(INVALID_CREDENTIALS);
        }
        await expect(loginAs(NORMALIZED, PASSWORD)).resolves.toMatchObject({
          user: { email: NORMALIZED },
        });
      } finally {
        dead.disconnect();
      }
    });
  });

  it.fails(
    'revokes a live session when the account behind it is deactivated (KNOWN GAP — open item S21)',
    async () => {
      await createAccount(NORMALIZED, PASSWORD);
      const session = (await loginAs(NORMALIZED, PASSWORD)) as { refreshToken: string };
      await prisma.user.update({ where: { email: NORMALIZED }, data: { isActive: false } });

      // Intended: deactivation must end the sessions it was protecting. Actual: the session
      // blob in Redis is never re-checked against the account row, so this still resolves to
      // the user. Reported rather than silently omitted.
      await expect(
        new SessionRedisAuthStrategy(redis, appConfig()).validateRequest(
          requestWithCookie(session.refreshToken),
        ),
      ).resolves.toBeNull();
    },
  );
});

function requestWithCookie(sessionId: string): FastifyRequest {
  return {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}` },
  } as unknown as FastifyRequest;
}

async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UnauthorizedException) return error.message;
    throw error;
  }
  throw new Error('expected the call to be rejected');
}
