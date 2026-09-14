/**
 * Boot smoke — TEST-PLAN.md §4 kind 6, and the step `orchestrate-skill.md` §7 makes mandatory.
 *
 * Every other suite in this repo substitutes something: the unit specs fake their
 * dependencies, the e2e suite replaces the persistence boundary, the contract suite drives
 * repositories directly. None of them boots the composition root against real drivers and
 * speaks HTTP to it. That gap is not theoretical — Wave 7 shipped three runtime crashes in a
 * global interceptor, the exception filter and the throttler guard that `build`, `test`,
 * `tsc`, `oxlint`, a clean boot and an adversarial code reading all passed. They were only
 * visible by executing a real request against a running app. So this script boots the real
 * `AppModule` over real Postgres and real Redis, then asserts on real HTTP responses.
 *
 * It asserts what a working service must do, phrased so a broken one fails:
 *   - the app boots with DI resolved and every expected route mapped
 *   - register -> login -> authenticated read -> authorization check -> logout all work
 *   - an unauthenticated read is refused
 *   - GraphQL answers on the same app instance
 *
 * Run with:  pnpm test:smoke        (needs `pnpm test:services:up` first)
 * Exits non-zero on the first failed assertion.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// Type-only, so it is erased at compile time and does not drag the Nest runtime into this
// module before the environment is set — which is why the value imports below are dynamic.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';

/**
 * Paths are resolved from the project root, not `import.meta.url`: this file is compiled to
 * `.smoke-dist/test/smoke/` before it runs, and the migration `.sql` files and `rbac.seed.json`
 * are source assets that tsc does not copy. `test:smoke` always runs from the project root.
 */
const PROJECT_ROOT = process.cwd();

const PG_ADMIN_URL = 'postgresql://auth:auth@localhost:55432/postgres';
const SMOKE_DB = 'auth_smoke';
const SMOKE_DB_URL = `postgresql://auth:auth@localhost:55432/${SMOKE_DB}`;
const REDIS_URL = 'redis://localhost:56379';

const PASSWORD = 'Passw0rd!23';
const EMAIL = `smoke-${Date.now()}@example.com`;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name);
}
const failures: string[] = [];

/** A real HTTP call — the point of this script is that nothing here is a synthetic probe. */
async function call(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  // Only declare a body when there is one. Sending `content-type: application/json` with an
  // empty body makes Fastify hand the DTO validation pipe an empty object, which rejects
  // `POST /auth/logout` with a 400 that has nothing to do with logout.
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: any = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON response is itself a finding; `text` carries it */
  }
  return { status: res.status, body, text };
}

async function prepareDatabase(): Promise<void> {
  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [SMOKE_DB]);
  if (existing.rowCount === 0) await admin.query(`CREATE DATABASE ${SMOKE_DB}`);
  await admin.end();

  // The migration SQL is the source of truth for the schema — the same files a real deploy
  // applies. Sorted lexically, which is what the timestamp prefixes are for.
  const migrationsDir = join(PROJECT_ROOT, 'src/database/migrations');
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const db = new Client({ connectionString: SMOKE_DB_URL });
  await db.connect();
  // Re-runnable: start from a clean schema so a stale run cannot make this pass or fail.
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const dir of dirs) {
    const sql = readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8');
    await db.query(sql);
  }
  await db.end();
  record('schema migrated', true, `${dirs.length} migration(s) applied to ${SMOKE_DB}`);
}

function seedBaseline(): void {
  execFileSync('pnpm', ['seed:rbac'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: SMOKE_DB_URL,
      DB_PROVIDER: 'prisma',
      AUTH_STRATEGY: 'jwt-stateless',
      RBAC_STRATEGY: 'db-live',
      REDIS_URL,
    },
    stdio: 'pipe',
  });
  record('rbac seeded', true, 'the real `pnpm seed:rbac` path ran to completion');
}

async function main(): Promise<void> {
  await prepareDatabase();
  seedBaseline();

  // The app's config module validates the environment at construction, so these must be set
  // before AppModule is imported — hence the dynamic import below rather than a top-level one.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = SMOKE_DB_URL;
  process.env.DB_PROVIDER = 'prisma';
  process.env.AUTH_STRATEGY = 'jwt-stateless';
  process.env.RBAC_STRATEGY = 'db-live';
  process.env.REDIS_URL = REDIS_URL;
  process.env.JWT_ALGORITHM = 'HS256';
  process.env.JWT_SECRET = 'smoke-only-ephemeral-secret-value-at-least-32-chars';

  const { NestFactory } = await import('@nestjs/core');
  const { FastifyAdapter } = await import('@nestjs/platform-fastify');
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/configure-app.js');

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ['error'],
  });
  await configureApp(app);
  // Port 0: an ephemeral port, so this never collides with a dev server or another run.
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  record('app booted', true, `listening on ${base}`);

  try {
    // Asked of the router itself rather than scraped out of `printRoutes()`, whose tree
    // output is formatted for humans and did not contain these paths as literal substrings —
    // a probe that reports "unmapped" for routes that demonstrably answer requests is
    // measuring its own parser, not the app (orchestrate-skill.md §9a).
    const router = app.getHttpAdapter().getInstance();
    const routeIsMapped = (method: 'GET' | 'POST', url: string): boolean =>
      router.hasRoute({ method, url });
    const expected = [
      ['POST', '/auth/register'],
      ['POST', '/auth/login'],
      ['GET', '/auth/me'],
      ['POST', '/authz/check'],
      ['POST', '/graphql'],
    ] as const;
    for (const [method, url] of expected) {
      record(`route mapped: ${method} ${url}`, routeIsMapped(method, url), `${method} ${url}`);
    }

    // --- the credential lifecycle, over real HTTP against real Postgres ------------------
    const registered = await call(base, '/auth/register', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    record(
      'register returns 201 + a session',
      registered.status === 201 && typeof registered.body?.data?.accessToken === 'string',
      `status=${registered.status} body=${registered.text.slice(0, 200)}`,
    );
    const token: string | undefined = registered.body?.data?.accessToken;

    const loggedIn = await call(base, '/auth/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    record(
      'login returns 200 + a session',
      loggedIn.status === 200 && typeof loggedIn.body?.data?.accessToken === 'string',
      `status=${loggedIn.status}`,
    );

    const me = await call(base, '/auth/me', { token });
    record(
      'authenticated /auth/me resolves the caller',
      me.status === 200 && me.body?.data?.email === EMAIL,
      `status=${me.status} body=${me.text.slice(0, 200)}`,
    );

    const allowed = await call(base, '/authz/check', {
      method: 'POST',
      token,
      body: { action: 'read', subject: 'Post' },
    });
    record(
      'a granted permission is allowed',
      allowed.status === 200 && allowed.body?.data?.allowed === true,
      `status=${allowed.status} body=${allowed.text.slice(0, 200)}`,
    );

    const denied = await call(base, '/authz/check', {
      method: 'POST',
      token,
      body: { action: 'update', subject: 'Post' },
    });
    record(
      'an ungranted permission is denied',
      denied.status === 200 && denied.body?.data?.allowed === false,
      `status=${denied.status} body=${denied.text.slice(0, 200)}`,
    );

    const anonymous = await call(base, '/auth/me');
    record('an unauthenticated read is refused', anonymous.status === 401, `status=${anonymous.status}`);

    // --- GraphQL on the same instance ----------------------------------------------------
    const gql = await call(base, '/graphql', {
      method: 'POST',
      token,
      body: { query: '{ me { email } }' },
    });
    record(
      'GraphQL answers an authenticated query',
      gql.status === 200 && gql.body?.errors === undefined && gql.body?.data?.me?.email === EMAIL,
      `status=${gql.status} body=${gql.text.slice(0, 300)}`,
    );

    const logout = await call(base, '/auth/logout', { method: 'POST', token });
    record('logout returns 204', logout.status === 204, `status=${logout.status}`);
  } finally {
    await app.close();
  }
}

await main();

const failed = checks.filter((check) => !check.ok);
const report = checks
  .map((check) => `  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}${check.ok ? '' : `\n        ${check.detail}`}`)
  .join('\n');

console.log(`\nboot smoke — ${checks.length - failed.length}/${checks.length} passed\n${report}\n`);

/**
 * `exitCode`, not `process.exit`. This script used to need a forced exit: `app.close()`
 * released nothing, so the Prisma pool and the Redis client `LoginAttemptService` opens for
 * itself kept the loop alive and the process hung open indefinitely after all 16 checks
 * passed. Both now close on shutdown — `DatabaseLifecycle` and
 * `LoginAttemptService.onModuleDestroy` — so the process ends on its own, which is itself
 * evidence the teardown works. If it ever stops exiting, that is the regression, and this
 * comment is where to look.
 */
if (failed.length > 0) {
  console.error(`boot smoke FAILED: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('boot smoke passed');
}
