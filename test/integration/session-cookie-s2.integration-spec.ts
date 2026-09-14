import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME, createSessionCookieOptions } from '../../src/auth-strategies/session-redis/session-cookie.js';
import { SESSION_TTL_SECONDS } from '../../src/auth-strategies/session-redis/session-store.js';
import { SessionRedisAuthStrategy } from '../../src/auth-strategies/session-redis/session-redis.auth-strategy.js';
import { LoginAttemptService } from '../../src/common/security/login-attempt.service.js';
import { PasswordService } from '../../src/common/security/password.service.js';
import { PrismaRoleRepository } from '../../src/database/repositories/prisma-role.repository.js';
import { PrismaUserRepository } from '../../src/database/repositories/prisma-user.repository.js';
import { AuthController } from '../../src/modules/auth/auth.controller.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import type { AuthzService } from '../../src/modules/auth/authz.service.js';
import type { LoginDto } from '../../src/modules/auth/dto/index.js';
import {
  appConfig,
  clearRedisKeys,
  createPrismaClient,
  createRedisClient,
  migrateDatabase,
  truncateAll,
} from './support/live-services.js';

/**
 * S2 — WAVE-LOG open item: *"Session cookie never attached under `session-redis`"*.
 *
 * `SessionRedisAuthStrategy` states the gap in its own doc comment: `login` has no response
 * handle, so the session id travels back inside `AuthResult.refreshToken` and
 * `createSessionCookieOptions()` is never applied by any caller. Cookie-only refresh therefore
 * cannot work, and the credential the strategy was built around is not httpOnly in practice.
 *
 * The failing test below is the INTENDED behaviour, not a wish: it is what closes S2. It is
 * quarantined with `it.fails` so the suite stays honest (a red suite hides new failures) while
 * the hole stays visible and cannot be quietly deleted.
 */
describe('session cookie delivery (S2) against real Redis', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let auth: AuthService;
  let attempts: LoginAttemptService;

  const EMAIL = 's2@example.com';
  const PASSWORD = 'Correct-Horse-Battery-9';

  beforeAll(async () => {
    await migrateDatabase();
    prisma = createPrismaClient();
    redis = createRedisClient();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await clearRedisKeys(redis);
    attempts = new LoginAttemptService(appConfig());
    auth = new AuthService(
      new PrismaUserRepository(prisma),
      new PrismaRoleRepository(prisma),
      new SessionRedisAuthStrategy(redis, appConfig()),
      new PasswordService(),
      attempts,
    );
  });

  afterAll(async () => {
    await clearRedisKeys(redis);
    await redis.quit();
    await prisma.$disconnect();
  });

  async function createAccount(): Promise<void> {
    const passwordHash = await new PasswordService().hash(PASSWORD);
    await prisma.user.create({ data: { email: EMAIL, passwordHash } });
  }

  describe('createSessionCookieOptions — the flags the cookie must carry', () => {
    it('is httpOnly, sameSite=strict and scoped to the whole API', () => {
      const options = createSessionCookieOptions(appConfig(), SESSION_TTL_SECONDS);

      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe('strict');
      expect(options.path).toBe('/');
      expect(options.maxAge).toBe(SESSION_TTL_SECONDS);
    });

    it('is not secure outside production and becomes secure in it', () => {
      expect(createSessionCookieOptions(appConfig(), 60).secure).toBe(false);
      expect(createSessionCookieOptions(appConfig({ NODE_ENV: 'production' }), 60).secure).toBe(true);
    });
  });

  // QUARANTINED: S2 (WAVE-LOG). Verified red — `expected undefined to be defined` — before it
  // was marked `it.fails`. Remove that marker when a caller starts attaching the cookie.
  it.fails('attaches the httpOnly session cookie to the login response (S2)', async () => {
    await createAccount();
    const reply = createReplyRecorder();

    // The third argument is the seam a fix adds. Casting keeps this probe valid both before
    // and after that fix, so the test flips from failing to passing when S2 is closed.
    const controller = authController();
    const loginWithReply = controller.login.bind(controller) as unknown as (
      dto: LoginDto,
      request: FastifyRequest,
      reply: ReplyRecorder,
    ) => Promise<unknown>;
    await loginWithReply({ email: EMAIL, password: PASSWORD } as LoginDto, request(), reply);

    expect(reply.cookies[SESSION_COOKIE_NAME], 'sid cookie on the login response').toBeDefined();
    expect(reply.cookies[SESSION_COOKIE_NAME]?.options).toMatchObject({ httpOnly: true, sameSite: 'strict' });
  });

  function authController(): AuthController {
    return new AuthController(auth, {} as AuthzService);
  }
});

interface ReplyRecorder {
  cookies: Record<string, { value: string; options: unknown }>;
  setCookie(name: string, value: string, options: unknown): void;
}

function createReplyRecorder(): ReplyRecorder {
  const cookies: ReplyRecorder['cookies'] = {};
  return {
    cookies,
    setCookie(name, value, options) {
      cookies[name] = { value, options };
    },
  };
}

function request(): FastifyRequest {
  return { headers: {}, ip: '127.0.0.1' } as unknown as FastifyRequest;
}
