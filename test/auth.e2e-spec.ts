import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  ROLE_REPOSITORY,
  USER_REPOSITORY,
} from '../src/common/constants.js';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { LoggingInterceptor } from '../src/common/interceptors/logging.interceptor.js';
import { TimeoutInterceptor } from '../src/common/interceptors/timeout.interceptor.js';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor.js';
import { LoginAttemptService } from '../src/common/security/login-attempt.service.js';
import { AppConfig } from '../src/config/app-config.service.js';
import { AppModule } from '../src/app.module.js';
import {
  createInMemoryPermissionRepository,
  createInMemoryRefreshTokenRepository,
  createInMemoryRoleRepository,
  createInMemoryStore,
  createInMemoryUserRepository,
  seedBaselineRbac,
  type InMemoryStore,
} from './support/in-memory-repositories.js';
import {
  createTestThrottlerStorage,
  type ResettableThrottlerStorage,
} from './support/test-throttler-storage.js';

/**
 * The in-memory session store standing in for ioredis. `SessionRedisAuthStrategy` (and
 * `db-live`'s cache) would otherwise dial a real Redis, which no e2e run has. Only the
 * client implementation is substituted — the strategy's own logic is untouched.
 */
vi.mock('ioredis', () => {
  class Redis {
    private readonly entries = new Map<string, string>();
    async get(key: string): Promise<string | null> {
      return this.entries.get(key) ?? null;
    }
    async set(key: string, value: string): Promise<'OK'> {
      this.entries.set(key, value);
      return 'OK';
    }
    async expire(): Promise<number> {
      return 1;
    }
    async del(key: string): Promise<number> {
      return this.entries.delete(key) ? 1 : 0;
    }
  }
  return { Redis, default: Redis };
});

/** plan.md §11 Phase 13: the same suite, run once per `AUTH_STRATEGY` value. */
const STRATEGIES = ['jwt-stateless', 'session-redis'] as const;
type AuthStrategy = (typeof STRATEGIES)[number];

const PASSWORD = 'Passw0rd!23';

/**
 * The store is shared by every test in a run (rebuilding the app per test would mean two app
 * boots per assertion), so each test that needs an account registers its own address rather
 * than depending on one a sibling test may already have created.
 */
let emailCounter = 0;
function uniqueEmail(): string {
  emailCounter += 1;
  return `user${emailCounter}@example.com`;
}

/** What `register`/`login` hand back — the credential differs per strategy, nothing else does. */
interface Session {
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Applies the strategy's own credential to a request. This is the only place the two runs
 * diverge: `jwt-stateless` carries a bearer access token, `session-redis` an opaque session
 * id in its cookie. Every assertion below is written once and holds for both.
 */
function authorize(req: request.Test, session: Session, strategy: AuthStrategy): request.Test {
  return strategy === 'session-redis'
    ? req.set('Cookie', `sid=${encodeURIComponent(session.refreshToken ?? '')}`)
    : req.set('Authorization', `Bearer ${session.accessToken}`);
}

/**
 * Boots the real `AppModule` with only the persistence boundary replaced, and re-applies the
 * global pipe/interceptors/filter `main.ts` installs — without them the suite would test a
 * surface no client ever talks to.
 */
async function createApp(
  strategy: AuthStrategy,
  store: InMemoryStore,
): Promise<{ app: NestFastifyApplication; throttler: ResettableThrottlerStorage }> {
  const configRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const realConfig = configRef.get(AppConfig);
  const strategyConfig = new Proxy(realConfig, {
    get(target, property) {
      if (property === 'AUTH_STRATEGY') return strategy;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await configRef.close();

  const throttler = createTestThrottlerStorage();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue(strategyConfig)
    .overrideProvider(USER_REPOSITORY)
    .useValue(createInMemoryUserRepository(store))
    .overrideProvider(ROLE_REPOSITORY)
    .useValue(createInMemoryRoleRepository(store))
    .overrideProvider(PERMISSION_REPOSITORY)
    .useValue(createInMemoryPermissionRepository(store))
    .overrideProvider(REFRESH_TOKEN_REPOSITORY)
    .useValue(createInMemoryRefreshTokenRepository(store))
    .overrideProvider(ThrottlerStorage)
    .useValue(throttler)
    // `LoginAttemptService` builds its own client (neither strategy module exports
    // `REDIS_CLIENT`), so it is handed one through the seam its doc comment names for specs.
    .overrideProvider(LoginAttemptService)
    .useValue(new InMemoryLoginAttemptService(strategyConfig))
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalInterceptors(
    app.get(LoggingInterceptor),
    app.get(TimeoutInterceptor),
    app.get(TransformInterceptor),
  );
  app.useGlobalFilters(app.get(HttpExceptionFilter));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, throttler };
}

/**
 * `LoginAttemptService`'s own in-memory Redis, so the suite never dials 127.0.0.1:6379 while
 * the lockout counter still behaves like the real thing (a failing login still counts).
 */
class InMemoryLoginAttemptService extends LoginAttemptService {
  protected override createClient(): Redis {
    const entries = new Map<string, string>();
    return {
      async incr(key: string) {
        const next = Number(entries.get(key) ?? 0) + 1;
        entries.set(key, String(next));
        return next;
      },
      async expire() {
        return 1;
      },
      async get(key: string) {
        return entries.get(key) ?? null;
      },
      async del(key: string) {
        return entries.delete(key) ? 1 : 0;
      },
    } as unknown as Redis;
  }
}

describe.each(STRATEGIES)('auth e2e — AUTH_STRATEGY=%s', (strategy) => {
  let app: NestFastifyApplication;
  let store: InMemoryStore;
  let throttler: ResettableThrottlerStorage;

  beforeAll(async () => {
    store = createInMemoryStore();
    seedBaselineRbac(store);
    ({ app, throttler } = await createApp(strategy, store));
  });

  beforeEach(() => {
    // Each test starts with a clean rate-limit window; the storage is real, only reset-able.
    throttler.reset();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function registerWith(email: string): Promise<Session> {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    return res.body.data as Session;
  }

  async function register(): Promise<{ session: Session; email: string }> {
    const email = uniqueEmail();
    return { session: await registerWith(email), email };
  }

  describe('register', () => {
    it('issues a session and lowercases the email at the boundary', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'Person@Example.com', password: PASSWORD })
        .expect(201);

      expect(res.body.data.user.email).toBe('person@example.com');
      // The default role, resolved through the repository — not baked into the controller.
      expect(res.body.data.user.roles).toEqual(['user']);
      expect(res.body.data.expiresAt).toEqual(expect.any(String));
    });

    it('refuses a second registration for the same address in any case', async () => {
      const email = uniqueEmail();
      await registerWith(email);
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: email.toUpperCase(), password: PASSWORD })
        .expect(409);
    });

    it('rejects a weak password before touching the repository', async () => {
      const before = store.users.length;
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'weak@example.com', password: 'password' })
        .expect(400);
      expect(store.users.length).toBe(before);
    });

    it('rejects an unknown field rather than silently ignoring it', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'extra@example.com', password: PASSWORD, isAdmin: true })
        .expect(400);
    });
  });

  describe('login', () => {
    it('accepts the right password, case-insensitively on the address', async () => {
      const { email } = await register();
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: email.toUpperCase(), password: PASSWORD })
        .expect(200);
    });

    it('gives the identical message for a wrong password and an unknown address', async () => {
      const { email } = await register();

      const wrongPassword = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'Wr0ng!password' })
        .expect(401);
      const unknownAddress = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: PASSWORD })
        .expect(401);

      expect(wrongPassword.body.message).toBe(unknownAddress.body.message);
      expect(wrongPassword.body.message).toBe('Invalid email or password');
    });
  });

  describe('GET /auth/me', () => {
    it('refuses an unauthenticated caller', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });

    it('returns the caller identity with grants resolved through the RBAC strategy', async () => {
      const { session, email } = await register();

      const res = await authorize(request(app.getHttpServer()).get('/auth/me'), session, strategy).expect(200);

      expect(res.body.data.email).toBe(email);
      expect(res.body.data.roles).toEqual(['user']);
      expect(res.body.data.permissions).toEqual(['read:Post']);
    });
  });

  describe('POST /authz/check', () => {
    it('allows a permission the caller holds', async () => {
      const { session } = await register();

      const res = await authorize(
        request(app.getHttpServer()).post('/authz/check').send({ action: 'read', subject: 'Post' }),
        session,
        strategy,
      ).expect(200);

      expect(res.body.data).toEqual({ allowed: true });
    });

    it('denies a permission the caller does not hold', async () => {
      const { session } = await register();

      const res = await authorize(
        request(app.getHttpServer()).post('/authz/check').send({ action: 'update', subject: 'Post' }),
        session,
        strategy,
      ).expect(200);

      expect(res.body.data).toEqual({ allowed: false });
    });

    it('matches the subject case-sensitively', async () => {
      const { session } = await register();

      const res = await authorize(
        request(app.getHttpServer()).post('/authz/check').send({ action: 'read', subject: 'post' }),
        session,
        strategy,
      ).expect(200);

      expect(res.body.data).toEqual({ allowed: false });
    });

    it('refuses an unauthenticated caller', async () => {
      await request(app.getHttpServer())
        .post('/authz/check')
        .send({ action: 'read', subject: 'Post' })
        .expect(401);
    });

    it('rejects a malformed body', async () => {
      const { session } = await register();
      await authorize(request(app.getHttpServer()).post('/authz/check').send({ action: 'read' }), session, strategy)
        .expect(400);
    });
  });

  describe('refresh', () => {
    it('rotates the credential', async () => {
      const { session, email } = await register();

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      expect(res.body.data.user.email).toBe(email);
    });

    it('rejects a forged credential', async () => {
      await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: 'not-a-real-token' }).expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the session so the credential can no longer be refreshed', async () => {
      const { session } = await register();

      await authorize(request(app.getHttpServer()).post('/auth/logout'), session, strategy).expect(204);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(app.getHttpServer()).post('/auth/logout').expect(401);
    });
  });

  describe('rbac-admin', () => {
    it('denies a caller without manage:User — and the guard, not the service, is what denies', async () => {
      const { session } = await register();

      await authorize(request(app.getHttpServer()).get('/rbac-admin/roles'), session, strategy).expect(403);
    });

    it('refuses an unauthenticated caller before authorization is even consulted', async () => {
      await request(app.getHttpServer()).get('/rbac-admin/roles').expect(401);
    });
  });

  describe('rate limiting', () => {
    it('enforces the register ceiling (3 per 60s) with a 429', async () => {
      const attempt = (index: number) =>
        request(app.getHttpServer())
          .post('/auth/register')
          .send({ email: `flood${index}@example.com`, password: PASSWORD });

      await attempt(1).expect(201);
      await attempt(2).expect(201);
      await attempt(3).expect(201);
      await attempt(4).expect(429);
    });

    it('keeps the credential-guessing ceiling on login (5 per 60s)', async () => {
      const { email } = await register();
      const attempt = () =>
        request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });

      for (let i = 0; i < 5; i += 1) await attempt();
      await attempt().expect(429);
    });
  });
});
