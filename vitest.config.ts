import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { coverageConfig } from './vitest.coverage.js';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    coverage: coverageConfig,
    // Any spec that compiles AppModule boots through the zod env schema, which refuses
    // to start without valid secrets — so tests get a throwaway HS256 config.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://auth:auth@localhost:5432/auth_test',
      JWT_ALGORITHM: 'HS256',
      JWT_SECRET: 'test-only-ephemeral-secret-value-at-least-32-chars',
    },
  },
});
