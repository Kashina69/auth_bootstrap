import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { coverageConfig } from './vitest.coverage.js';

/**
 * Adapter contract suite (TEST-PLAN.md §4 kind 2): all four ORM adapters driven through one
 * shared behavioural contract, against real databases.
 *
 * `fileParallelism: false` is deliberate (§7.4/§7.5). The Prisma, Drizzle and Sequelize specs
 * all speak to the same Postgres and each resets its tables between tests, so two files in
 * flight at once would truncate each other's rows — the classic "passes alone, fails together".
 * They are quick, and correctness beats four seconds of wall clock.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/contract/**/*.contract-spec.ts'],
    fileParallelism: false,
    coverage: coverageConfig,
    env: {
      NODE_ENV: 'test',
      // Three of the four adapters are Postgres; Mongoose dials its own URL (below). A
      // contract suite that cannot run one of its four providers is not a contract suite.
      DATABASE_URL: 'postgresql://auth:auth@localhost:55432/auth_contract',
      MONGO_URL: 'mongodb://localhost:57017/auth_contract',
      DB_PROVIDER: 'prisma',
      JWT_ALGORITHM: 'HS256',
      JWT_SECRET: 'test-only-ephemeral-secret-value-at-least-32-chars',
    },
  },
});
