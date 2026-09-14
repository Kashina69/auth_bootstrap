import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { coverageConfig } from './vitest.coverage.js';

/**
 * Live-service integration suite (TEST-PLAN.md §4 kind 3): real Redis, real Postgres.
 *
 * `fileParallelism: false` is deliberate (§7.5). Every spec here shares one Redis and one
 * database, and the lockout counters and cache keys are global — two files at once would
 * make each other's keys and rows unpredictable. This is the config where "passes alone,
 * fails together" would otherwise be guaranteed rather than merely likely.
 *
 * Note there is no `setupFiles` here: the e2e config's ioredis stand-in must NOT apply, since
 * the live Redis behaviour is the thing under test.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.integration-spec.ts'],
    fileParallelism: false,
    // Real Redis TTLs and argon2 are genuinely slow; a default 5s timeout produces flakes
    // that look like defects.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: coverageConfig,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://auth:auth@localhost:55432/auth_integration',
      REDIS_URL: 'redis://localhost:56379',
      AUTH_STRATEGY: 'session-redis',
      RBAC_STRATEGY: 'db-live',
      DB_PROVIDER: 'prisma',
      JWT_ALGORITHM: 'HS256',
      JWT_SECRET: 'test-only-ephemeral-secret-value-at-least-32-chars',
    },
  },
});
