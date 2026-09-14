import type { CoverageOptions } from 'vitest/node';

/**
 * Coverage policy — TEST-PLAN.md §6. Shared by every vitest config so there is exactly one
 * place thresholds are ratcheted.
 *
 * **Coverage is a gap-finder, not a gate on correctness.** The Wave 6 `isSystem` defect sat
 * behind a fully-covered, fully-green file; a number would not have caught it, a mutation
 * check would have (§2b). Read a red threshold as "something stopped being exercised", not
 * as "the security property holds".
 *
 * The `include` is deliberately the whole of `src/`, not just the tested parts. Vitest's
 * default reports only files a test happened to import, which is how this suite read as 91%
 * while `src/database/` — 16 repository implementations, four ORMs — was at zero and simply
 * absent from the table. Naming `src/**` puts the untested layer back in the report where it
 * can be seen.
 */
export const coverageConfig: CoverageOptions = {
  provider: 'v8',
  // Left off deliberately: coverage is enabled by the `--coverage` flag in `test:cov`, so a
  // plain `pnpm test` stays fast and its output stays a test report.
  include: ['src/**/*.ts'],
  exclude: [
    // Wiring and declarations: nothing here has behaviour a test could assert.
    'src/**/*.module.ts',
    'src/**/*.types.ts',
    'src/main.ts',
    // The zod schema and the module's own config plumbing are exercised by the boot smoke
    // script, which is a stronger check than line coverage of a getter.
    'src/config/**',
  ],
  reporter: ['text', 'json-summary'],

  /**
   * Per-directory floors on the security-critical surface only. Everything else is reported
   * and unenforced on purpose: this codebase has thin, well-tested core layers and thick,
   * adapter layers, and one global percentage hides exactly that distinction.
   *
   * These are floors measured at the Wave 0 baseline, rounded down to whole percent — a
   * ratchet, not an aspiration. `src/database/repositories/**` deliberately has none: Wave 1
   * covers those behaviourally through the contract suite, which is a stronger guarantee than
   * line coverage and does not need a number.
   */
  thresholds: {
    // The sole deny-gate. `can()` is the whole authorization decision — hold it at 100%.
    'src/rbac-core/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
    // Credential issue / validate / rotate.
    'src/auth-strategies/**': { statements: 92, branches: 79, functions: 96, lines: 96 },
    // Permission resolution.
    'src/rbac-strategies/**': { statements: 98, branches: 95, functions: 100, lines: 100 },
    // argon2 and the lockout counter.
    'src/common/security/**': { statements: 96, branches: 83, functions: 92, lines: 96 },
    // The enforcement points.
    'src/common/guards/**': { statements: 97, branches: 94, functions: 100, lines: 97 },
  },
};
