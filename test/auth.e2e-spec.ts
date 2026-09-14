import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryStore, seedBaselineRbac, type InMemoryStore } from './support/in-memory-repositories.js';
import {
  authorize,
  createTestApp,
  PASSWORD,
  STRATEGIES,
  uniqueEmail,
  type Session,
} from './support/harness.js';
import type { ResettableThrottlerStorage } from './support/test-throttler-storage.js';

/**
 * The REST half of the e2e suite. The app boot, the persistence substitution and the
 * per-strategy credential live in `test/support/harness.ts`; the GraphQL half
 * (`graphql.e2e-spec.ts`) shares them, which is what makes the REST-vs-GraphQL parity
 * assertions in that file meaningful.
 */
describe.each(STRATEGIES)('auth e2e — AUTH_STRATEGY=%s', (strategy) => {
  let app: NestFastifyApplication;
  let store: InMemoryStore;
  let throttler: ResettableThrottlerStorage;

  beforeAll(async () => {
    store = createInMemoryStore();
    seedBaselineRbac(store);
    ({ app, throttler } = await createTestApp(strategy, store));
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
