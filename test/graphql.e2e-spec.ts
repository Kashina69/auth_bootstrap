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
 * The GraphQL half of the e2e suite — the twin of `auth.e2e-spec.ts`, booted from the same
 * harness (real `AppModule`, real guards/strategies/resolvers/DTO validation, only the
 * persistence boundary replaced) and run once per `AUTH_STRATEGY`.
 *
 * Two properties are the point of this file, not incidental:
 *   - the globals `configureApp` installs (ValidationPipe, the exception filter, the throttler)
 *     must behave for a GraphQL operation exactly as they do for its REST twin;
 *   - for the same input the two transports must answer the same thing (plan.md §10).
 *
 * The operations are written as inline literals on purpose. GraphQL variables are exercised
 * once, in the quarantined S13 test at the bottom — that is the only place they are known to
 * misbehave, and it must not be allowed to hide behind the rest of the suite.
 */

/** What a `register`/`login`/`refresh` mutation resolves to, as Apollo serialises it. */
interface GraphqlAuthResult {
  expiresAt: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  user: {
    id: string;
    email: string;
    isActive: boolean;
    isEmailVerified: boolean;
    roles?: string[] | null;
    permissions?: string[] | null;
  };
}

// Every interpolated value goes through JSON.stringify, so it lands as a properly escaped
// GraphQL string literal whatever the credential contains — an opaque session id has no
// guaranteed charset.
const REGISTER = (email: string, password: string) => `
  mutation {
    register(input: { email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }) {
      expiresAt
      accessToken
      refreshToken
      user { id email isActive isEmailVerified roles permissions }
    }
  }`;

const LOGIN = (email: string, password: string) => `
  mutation {
    login(input: { email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }) {
      expiresAt
      accessToken
      refreshToken
      user { id email isActive isEmailVerified roles permissions }
    }
  }`;

const REFRESH = (refreshToken: string) => `
  mutation {
    refresh(input: { refreshToken: ${JSON.stringify(refreshToken)} }) {
      expiresAt
      accessToken
      refreshToken
      user { email }
    }
  }`;

const LOGOUT = 'mutation { logout }';

const ME = 'query { me { id email isActive isEmailVerified roles permissions } }';

const CHECK_PERMISSION = (action: string, subject: string) => `
  query {
    checkPermission(input: { action: ${JSON.stringify(action)}, subject: ${JSON.stringify(subject)} }) {
      allowed
    }
  }`;

describe.each(STRATEGIES)('graphql e2e — AUTH_STRATEGY=%s', (strategy) => {
  let app: NestFastifyApplication;
  let store: InMemoryStore;
  let throttler: ResettableThrottlerStorage;

  beforeAll(async () => {
    store = createInMemoryStore();
    seedBaselineRbac(store);
    ({ app, throttler } = await createTestApp(strategy, store));
  });

  beforeEach(() => {
    throttler.reset();
  });

  afterAll(async () => {
    await app?.close();
  });

  function graphql(
    query: string,
    options: { session?: Session; variables?: Record<string, unknown> } = {},
  ): request.Test {
    const body: Record<string, unknown> = { query };
    // Only present when the caller asked for it: "no `variables` key at all" and
    // "variables sent but dropped" are the two probes WAVE-LOG used to characterise S13.
    if (options.variables) body.variables = options.variables;
    const req = request(app.getHttpServer()).post('/graphql').send(body);
    return options.session ? authorize(req, options.session, strategy) : req;
  }

  async function registerOverGraphql(email: string): Promise<GraphqlAuthResult> {
    const res = await graphql(REGISTER(email, PASSWORD)).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data.register as GraphqlAuthResult;
  }

  async function register(): Promise<{ session: Session; email: string }> {
    const email = uniqueEmail();
    const result = await registerOverGraphql(email);
    return {
      session: {
        accessToken: result.accessToken ?? undefined,
        refreshToken: result.refreshToken ?? undefined,
      },
      email,
    };
  }

  async function registerOverRest(email: string): Promise<GraphqlAuthResult> {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    return res.body.data as GraphqlAuthResult;
  }

  describe('register', () => {
    it('normalises the address and shapes the identity exactly as POST /auth/register does', async () => {
      const restEmail = uniqueEmail();
      const rest = await registerOverRest(restEmail.toUpperCase());
      const gqlEmail = uniqueEmail();
      const gql = await registerOverGraphql(gqlEmail.toUpperCase());

      expect(rest.user.email).toBe(restEmail);
      expect(gql.user.email).toBe(gqlEmail);
      expect(gql.user.roles).toEqual(rest.user.roles);
      expect(gql.user.permissions).toEqual(rest.user.permissions);
      expect(Object.keys(gql.user).sort()).toEqual(Object.keys(rest.user).sort());
      expect(gql.expiresAt).toEqual(expect.any(String));
      // The credential belongs to the strategy, not the transport: present iff REST presents one.
      expect(Boolean(gql.accessToken)).toBe(Boolean(rest.accessToken));
      expect(Boolean(gql.refreshToken)).toBe(Boolean(rest.refreshToken));
    });

    it('is not wrapped in the REST { data, meta } envelope by the global TransformInterceptor', async () => {
      const res = await graphql(REGISTER(uniqueEmail(), PASSWORD)).expect(200);

      expect(res.body.meta).toBeUndefined();
      expect(res.body.data.register.expiresAt).toEqual(expect.any(String));
    });

    it('refuses a duplicate address with the message REST returns for the same input', async () => {
      const email = uniqueEmail();
      await registerOverGraphql(email);

      const rest = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: email.toUpperCase(), password: PASSWORD })
        .expect(409);

      const res = await graphql(REGISTER(email.toUpperCase(), PASSWORD)).expect(200);

      expect(res.body.errors[0].message).toBe(rest.body.message);
    });

    it('rejects a weak password through the global ValidationPipe, before the repository', async () => {
      const before = store.users.length;
      const res = await graphql(REGISTER(uniqueEmail(), 'password')).expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.data?.register ?? null).toBeNull();
      expect(store.users.length).toBe(before);
    });

    it('rejects an input field the schema does not declare rather than ignoring it', async () => {
      const before = store.users.length;
      const res = await graphql(
        `mutation {
          register(input: { email: ${JSON.stringify(uniqueEmail())}, password: ${JSON.stringify(PASSWORD)}, isAdmin: true }) {
            expiresAt
          }
        }`,
      ).expect(400);

      // A GraphQL *validation* failure is Apollo's transport-level 400, not a 200-with-errors[]
      // — and the 400 still carries the structured error a client needs, naming the field.
      expect(res.body.errors[0].message).toContain('isAdmin');
      expect(store.users.length).toBe(before);
    });
  });

  describe('login', () => {
    it('accepts the right password, case-insensitively on the address', async () => {
      const { email } = await register();

      const res = await graphql(LOGIN(email.toUpperCase(), PASSWORD)).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.login.user.email).toBe(email);
      expect(res.body.data.login.user.permissions).toEqual(['read:Post']);
    });

    it('gives the identical message REST gives — for a wrong password and an unknown address alike', async () => {
      const { email } = await register();

      const rest = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'Wr0ng!password' })
        .expect(401);

      const wrongPassword = await graphql(LOGIN(email, 'Wr0ng!password')).expect(200);
      const unknownAddress = await graphql(LOGIN('nobody@example.com', PASSWORD)).expect(200);
      const restUnknown = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: PASSWORD })
        .expect(401);

      expect(wrongPassword.body.errors[0].message).toBe(unknownAddress.body.errors[0].message);
      expect(wrongPassword.body.errors[0].message).toBe(rest.body.message);
      expect(wrongPassword.body.errors[0].message).toBe(restUnknown.body.message);
    });

    it('accepts the same operation with the literals inlined, isolating variable delivery', async () => {
      const { email } = await register();

      // The control for S13: same field, same type, same DTO. Only the literal-vs-variable
      // difference separates this passing call from the quarantine at the bottom of the file.
      const res = await graphql(LOGIN(email, PASSWORD)).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.login.user.email).toBe(email);
    });
  });

  describe('me', () => {
    it('refuses an unauthenticated caller inside errors[], not as a transport 401 body', async () => {
      const res = await graphql(ME).expect(200);

      expect(res.body.errors[0].message).toMatch(/unauthorized/i);
      expect(res.body.data?.me ?? null).toBeNull();
      // The REST error body's markers; a GraphQL error must not arrive shaped like one.
      expect(res.body.statusCode).toBeUndefined();
      expect(res.body.path).toBeUndefined();
    });

    it('returns the identity GET /auth/me returns', async () => {
      const { session, email } = await register();

      const rest = await authorize(request(app.getHttpServer()).get('/auth/me'), session, strategy).expect(200);
      const res = await graphql(ME, { session }).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.me.email).toBe(email);
      expect(res.body.data.me).toEqual(rest.body.data);
    });
  });

  describe('checkPermission', () => {
    it('answers exactly what POST /authz/check answers, for allow and deny alike', async () => {
      const { session } = await register();

      for (const [action, subject] of [
        ['read', 'Post'],
        ['update', 'Post'],
        ['read', 'post'],
      ] as const) {
        const rest = await authorize(
          request(app.getHttpServer()).post('/authz/check').send({ action, subject }),
          session,
          strategy,
        ).expect(200);
        const res = await graphql(CHECK_PERMISSION(action, subject), { session }).expect(200);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data.checkPermission).toEqual(rest.body.data);
      }
    });

    it('refuses an unauthenticated caller inside errors[]', async () => {
      const res = await graphql(CHECK_PERMISSION('read', 'Post')).expect(200);

      expect(res.body.errors[0].message).toMatch(/unauthorized/i);
      expect(res.body.data?.checkPermission ?? null).toBeNull();
      expect(res.body.statusCode).toBeUndefined();
    });

    it('rejects a malformed input', async () => {
      const { session } = await register();

      const res = await graphql('query { checkPermission(input: { action: "read" }) { allowed } }', {
        session,
      }).expect(400);

      // Rejected against the schema before the resolver runs, and the error is attributed to
      // the argument that carried the malformed value rather than failing opaquely.
      expect(res.body.errors[0].message).toContain('Argument "input" has invalid value');
    });
  });

  describe('refresh', () => {
    it('rotates the credential and returns what POST /auth/refresh returns', async () => {
      const restRegistered = await registerOverRest(uniqueEmail());
      const gqlRegistered = await registerOverGraphql(uniqueEmail());

      const rest = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: restRegistered.refreshToken })
        .expect(200);
      const res = await graphql(REFRESH(gqlRegistered.refreshToken ?? '')).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.refresh.user.email).toBe(gqlRegistered.user.email);
      expect(res.body.data.refresh.expiresAt).toEqual(expect.any(String));
      expect(Boolean(res.body.data.refresh.accessToken)).toBe(Boolean(rest.body.data.accessToken));
      expect(Boolean(res.body.data.refresh.refreshToken)).toBe(Boolean(rest.body.data.refreshToken));
    });

    it('treats a superseded credential exactly as POST /auth/refresh does', async () => {
      // The two strategies legitimately differ here and the suite must not pick a side:
      // jwt-stateless rotates on every use and revokes the token family it replaced (CONTRACTS
      // §9), while session-redis slides the same opaque session id forward and so never
      // supersedes one. Asserting a fixed 401 would encode the jwt invariant as universal.
      // What must hold for both is that GraphQL and REST make the same call about the same
      // credential — a GraphQL-only replay hole is exactly what parity is here to catch.
      const restSession = await registerOverRest(uniqueEmail());
      const gqlSession = await registerOverGraphql(uniqueEmail());

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: restSession.refreshToken })
        .expect(200);
      const rotated = await graphql(REFRESH(gqlSession.refreshToken ?? '')).expect(200);
      expect(rotated.body.errors).toBeUndefined();

      const restReplay = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: restSession.refreshToken });
      const gqlReplay = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: gqlSession.refreshToken });

      expect(gqlReplay.status).toBe(restReplay.status);
    });

    it('rejects a forged credential with the message REST gives', async () => {
      const rest = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'not-a-real-token' })
        .expect(401);
      const res = await graphql(REFRESH('not-a-real-token')).expect(200);

      expect(res.body.errors[0].message).toBe(rest.body.message);
    });
  });

  describe('logout', () => {
    it('revokes the session so the credential can no longer be refreshed', async () => {
      const { session } = await register();

      const res = await authorize(graphql(LOGOUT), session, strategy).expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.logout).toBe(true);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    it('refuses an unauthenticated caller inside errors[]', async () => {
      const res = await graphql(LOGOUT).expect(200);

      expect(res.body.errors[0].message).toMatch(/unauthorized/i);
      expect(res.body.data?.logout ?? null).toBeNull();
    });
  });

  describe('rate limiting', () => {
    it('keeps the credential-guessing ceiling on the login mutation (5 per 60s)', async () => {
      const { email } = await register();

      // Wave 7 established that a GraphQL endpoint is not a rate-limit bypass, which is why the
      // global guard is a GraphQL-aware `ThrottlerGuard`. Delete that guard and every call below
      // succeeds — this test is what pins it.
      for (let i = 0; i < 5; i += 1) {
        const res = await graphql(LOGIN(email, PASSWORD)).expect(200);
        expect(res.body.errors).toBeUndefined();
      }

      const limited = await graphql(LOGIN(email, PASSWORD)).expect(200);
      expect(limited.body.errors[0].message).toMatch(/too many requests/i);
      expect(limited.body.data?.login ?? null).toBeNull();
    });

    it('keeps the register ceiling on the register mutation (3 per 60s)', async () => {
      for (let i = 0; i < 3; i += 1) {
        await registerOverGraphql(uniqueEmail());
      }

      const limited = await graphql(REGISTER(uniqueEmail(), PASSWORD)).expect(200);
      expect(limited.body.errors[0].message).toMatch(/too many requests/i);
    });
  });

  describe('GraphQL variables (S13)', () => {
    /**
     * S13 — WAVE-LOG.md, "Finding corrected — the recorded S13 hypothesis was wrong".
     * Measured against a live server: `query` reaches Apollo and **`variables` never does** —
     * the byte-identical error comes back with and without the `variables` key. The schema is
     * not implicated (`src/schema.gql` declares `input LoginDto` and `login(input: LoginDto!)`).
     *
     * This asserts the INTENDED behaviour, so it is red today; `it.fails` keeps the suite green
     * while the hole stays visible and tracked (TEST-PLAN.md §8). Delete the `.fails` when S13
     * is fixed. Do not weaken it into asserting the "Variable ... was not provided" error as
     * correct — pinning a broken behaviour as expected is how the Wave 6 `isSystem` defect
     * shipped as a passing test.
     *
     * Observed here, per strategy, on 400 with `extensions.code = GRAPHQL_VALIDATION_FAILED`:
     *   Variable "$input" of required type "LoginDto!" was not provided.
     * The control above (`login` with the same DTO and the literals inlined) succeeds, so the
     * operation, the schema and the resolver are all sound — only `variables` goes missing.
     * The assertions below are ordered so the failure prints that whole `errors[]`.
     */
    it.fails('delivers `variables` to the resolver instead of dropping them (S13)', async () => {
      const { email } = await register();

      const res = await graphql(`mutation Login($input: LoginDto!) { login(input: $input) { user { email } } }`, {
        variables: { input: { email, password: PASSWORD } },
      });

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.login.user.email).toBe(email);
    });
  });
});
