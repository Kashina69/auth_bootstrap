import { readdir, readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { SESSION_KEY_PREFIX } from '../../../src/auth-strategies/session-redis/session-store.js';
import { LoginAttemptService } from '../../../src/common/security/login-attempt.service.js';
import type { AppConfig } from '../../../src/config/app-config.service.js';
import { authzContextCacheKey } from '../../../src/rbac-strategies/db-live/authz-context-cache.js';

/**
 * Shared plumbing for the live-service suite (TEST-PLAN.md §4 kind 3).
 *
 * Everything here dials the real Postgres and the real Redis that
 * `vitest.config.integration.ts` points at. Nothing is faked — a fake would make the
 * assertions evidence about the fake rather than about the system (§2c).
 */

/** `src/` has no migrate runner: setup.md applies the migration SQL files by hand, in order. */
const MIGRATIONS_DIR = new URL('../../../src/database/migrations/', import.meta.url);

/** The key namespace `LoginAttemptService` owns; it exports no constant of its own. */
export const LOGIN_ATTEMPTS_PREFIX = 'login-attempts:';

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is unset — is vitest.config.integration.ts in use?');
  return url;
}

export function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is unset — is vitest.config.integration.ts in use?');
  return url;
}

/**
 * The constructors under test take `AppConfig` (a Nest provider) and read exactly one or two
 * getters off it; this supplies those without booting the Nest container. `NODE_ENV` matters:
 * it is what makes the session cookie `secure` in production.
 */
export function appConfig(overrides: Partial<{ REDIS_URL: string; NODE_ENV: string }> = {}): AppConfig {
  const env = overrides.NODE_ENV ?? 'test';
  const url = overrides.REDIS_URL ?? redisUrl();
  return { NODE_ENV: env, REDIS_URL: url } as unknown as AppConfig;
}

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl() });
}

export function createRedisClient(): Redis {
  return new Redis(redisUrl());
}

/**
 * A `LoginAttemptService` bound to a client the caller owns and can close.
 *
 * `LoginAttemptService` opens its own connection from `config.REDIS_URL` and offers exactly one
 * seam to replace it: the `createClient` hook its doc comment names for specs. The client is
 * captured in this closure rather than held as a class field because fields are assigned after
 * `super()` — and `super()` is what calls `createClient()`, so a field would still be
 * `undefined` at that moment and every command would fail open silently.
 */
export function loginAttemptsOn(client: Redis, config: AppConfig = appConfig()): LoginAttemptService {
  class BoundToClient extends LoginAttemptService {
    protected override createClient(): Redis {
      return client;
    }
  }
  return new BoundToClient(config);
}

/** The live Redis the suite owns, for callers that want the default wiring under test. */
export function loginAttemptsOnLiveRedis(): { service: LoginAttemptService; redis: Redis } {
  const redis = createRedisClient();
  return { service: loginAttemptsOn(redis), redis };
}

/**
 * A real ioredis client pointed at a port nothing listens on. It must reject fast rather than
 * sit in the offline queue: `maxRetriesPerRequest` bounds the attempt and `enableOfflineQueue:
 * false` turns "not connected" into an immediate command error, which is the state a Redis
 * outage actually presents to the application.
 */
export function unreachableRedisClient(): Redis {
  return new Redis('redis://localhost:56380', {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}

/**
 * Rebuilds the schema from the migration files themselves — `DROP SCHEMA` first so the run is
 * deterministic and the SQL is exercised on every suite, not just the first.
 */
export async function migrateDatabase(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    const migrations = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration}/migration.sql`, MIGRATIONS_DIR), 'utf8');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

/** One statement so the order of the table list can never matter. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE user_roles, role_permissions, refresh_tokens, users, roles, permissions CASCADE',
  );
}

/**
 * Scoped deletes rather than `FLUSHDB`: this Redis instance is shared with whatever else runs
 * against the test stack, and only these three namespaces belong to this suite.
 */
export async function clearRedisKeys(redis: Redis): Promise<void> {
  const prefixes = [SESSION_KEY_PREFIX, LOGIN_ATTEMPTS_PREFIX, 'rbac:context:'];
  for (const prefix of prefixes) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

/** Every key the suite can create, for assertions that scan rather than look one up. */
export async function allSuiteKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of [SESSION_KEY_PREFIX, LOGIN_ATTEMPTS_PREFIX, 'rbac:context:']) {
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      keys.push(...found);
    } while (cursor !== '0');
  }
  return keys;
}

export { authzContextCacheKey };
