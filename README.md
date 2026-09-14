# auth — NestJS Auth + RBAC Bootstrap

Drop-in, DB-backed, ORM-agnostic authentication + RBAC module for NestJS 12 (Fastify).

## Current state + how to resume (waves 1–7 of 8 done; verified 2026-09-14)

**To resume:** read `.agents/plan/orchestrate-skill.md` **first** — it is the process
(wave sizing, pre-flight, dispatch template, the gate, verification, the ledger). Then
`.agents/plan/MEMORY.md` for the build log and the latest checkpoint, and
`.agents/plan/WAVE-LOG.md` for the per-wave ledger (agents, token costs, defects, and the
numbered open-security-items table S1–S15).

**Gate at this checkpoint:** `pnpm build` exit 0 · `pnpm test` **13 files / 94 tests passed** ·
`pnpm exec tsc --noEmit` clean · `pnpm exec oxlint src/ test/` clean · app **boots** and serves
`/graphql` + 12 REST routes, with real requests verified end-to-end.

Plan docs under `.agents/plan/`:

- `plan.md` — the architecture (pluggable strategies, schema, `rbac-core`, REST+GraphQL parity)
- `implementation.spec.md` — the security-critical code spec (argon2, JWT pinning, refresh rotation, `can()`, guards, rate limiting, env validation, multi-ORM)
- `plan.agent.md` — the orchestrator + subagent wave schedule
- `CONTRACTS.md` — the frozen interfaces (DI tokens, repository contracts, strategy constructors), with a change log
- `STYLE.md` — the binding code-style contract
- `MEMORY.md` — running build log + decisions + latest checkpoint
- `WAVE-LOG.md` — per-wave ledger: agents, tokens, gate results, defects, open security items
- `orchestrate-skill.md` — how to run the build with subagents efficiently (read this to continue)

### What exists

- `src/config/` — zod-validated env (`AUTH_STRATEGY`, `RBAC_STRATEGY`, `DB_PROVIDER`, optional `CORS_ORIGINS`), fail-fast boot.
- `src/common/` — DI tokens, exception filter, redacting/logging + transform + timeout interceptors (all transport-aware).
- `src/common/decorators/` + `src/common/guards/` — `@Public`/`@Roles`/`@Permissions`/`@CurrentUser`, `AuthGuard`, `RbacGuard`, `GraphqlThrottlerGuard`.
- `src/common/security/` — `PasswordService` (argon2id) and `LoginAttemptService` (per-account lockout, degrades safely without Redis).
- `src/database/` — six-table schema + migrations + four repository contracts with **Prisma / Drizzle / Sequelize / Mongoose** adapters behind a `DB_PROVIDER` switch, plus an idempotent seed (`pnpm seed:rbac`).
- `src/rbac-core/` — framework-agnostic `can()`/`hasRole()`/`hasAnyPermission()` (zero deps).
- `src/auth-strategies/` — `jwt-stateless` (JWT + rotating refresh token w/ reuse detection) and `session-redis` (Redis session + cookie).
- `src/rbac-strategies/` — `embedded-claims` (baked claims) and `db-live` (live lookup + 5s cache).
- `src/modules/auth/` — `AuthService`, DTOs, REST controller, GraphQL resolver.
- `src/modules/rbac-admin/` — runtime role/permission CRUD (REST + GraphQL), every route behind `manage:User`.
- `src/graphql/` — Apollo code-first bootstrap with query depth/complexity limits.
- `src/main.ts` — helmet, conditional CSRF, CORS (deny-all unless configured), global validation/interceptors/filters.

### What's left

- **Wave 8** — `frontend-kit-agent` ∥ `test-agent`: unit + e2e coverage, `/auth/me` + `/authz/check`
  endpoints, React `usePermission()`, and `auth.guard.spec.ts` (S4).

### Known open items (full detail + severity in `WAVE-LOG.md`)

- **S13 — GraphQL variables do not work.** Sending `variables` with a `LoginDto`-typed variable is
  rejected at validation ("not usable as an input type"), so clients must inline literals. Found in
  Wave 7, not fixed. **The most likely next thing to look at.**
- **S1/S2 — `session-redis` is not shippable.** `logout` silently no-ops and the session cookie is
  never attached. Both need a contract-level decision above the controller. Inert under the default
  pairing (`jwt-stateless` + `embedded-claims`).
- **S14/S15** — GraphQL throttle responses omit rate-limit headers and return HTTP 200; lockout
  timing can reveal lockout state for a known address (deliberate, per spec §6).
- **S9/S11** — `deletePermission` does not fan out `invalidate()`; the seed never updates an
  existing permission row, so old rows keep `is_system = false`.
- **S4** — no `auth.guard.spec.ts`; the `@Public()` bypass and the `req.user = user` assignment are
  untested.
