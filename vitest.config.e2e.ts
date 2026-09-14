import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Registers the ioredis stand-in for every e2e file. It is scoped to this config on
    // purpose: the integration suite imports the same harness against a real Redis.
    setupFiles: ['./test/support/e2e-setup.ts'],
    // The env schema refuses to boot without valid secrets, so e2e boots against a
    // throwaway HS256 config instead of a checked-in .env file.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://auth:auth@localhost:5432/auth_e2e',
      JWT_ALGORITHM: 'HS256',
      JWT_SECRET: 'e2e-only-ephemeral-secret-value-at-least-32-chars',
      // Pinned so the suite is deterministic: the Phase 13 matrix varies AUTH_STRATEGY, and
      // coupling that to a second axis would double the runs without covering anything new.
      // db-live has its own unit spec; REDIS_URL only has to satisfy the schema (no live
      // Redis is dialed — `ioredis` is mocked in the spec).
      RBAC_STRATEGY: 'embedded-claims',
      REDIS_URL: 'redis://localhost:6379',
    },
  },
});
