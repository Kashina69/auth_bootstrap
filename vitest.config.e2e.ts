import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // The env schema refuses to boot without valid secrets, so e2e boots against a
    // throwaway HS256 config instead of a checked-in .env file.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://auth:auth@localhost:5432/auth_e2e',
      JWT_ALGORITHM: 'HS256',
      JWT_SECRET: 'e2e-only-ephemeral-secret-value-at-least-32-chars',
    },
  },
});
