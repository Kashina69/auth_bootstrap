# auth — NestJS Auth + RBAC Bootstrap

Drop-in, DB-backed, ORM-agnostic authentication + RBAC module for NestJS 12 (Fastify).

## Current state (checkpoint 2026-09-11 — waves 1–4 of 8 done)

The build is driven by a multi-agent plan under `.agents/plan/`:

- `plan.md` — the architecture (pluggable strategies, schema, `rbac-core`, REST+GraphQL parity)
- `implementation.spec.md` — the security-critical code spec (argon2, JWT pinning, refresh rotation, `can()`, guards, env validation, multi-ORM)
- `plan.agent.md` — the orchestrator + subagent wave schedule
- `CONTRACTS.md` — the frozen interfaces (DI tokens, repository contracts, strategy constructors)
- `STYLE.md` — the binding code-style contract
- `MEMORY.md` — the running build log + decisions + latest checkpoint

### What exists (verified green: `pnpm build` exit 0, 48 tests pass)

- `src/config/` — zod-validated env (`AUTH_STRATEGY`, `RBAC_STRATEGY`, `DB_PROVIDER`), fail-fast boot.
- `src/common/` — DI tokens, exception filter, redacting/logging + transform + timeout interceptors.
- `src/database/` — six-table schema + four repository contracts with **Prisma / Drizzle / Sequelize / Mongoose** adapters behind a `DB_PROVIDER` switch.
- `src/rbac-core/` — framework-agnostic `can()`/`hasRole()`/`hasAnyPermission()` (zero deps).
- `src/auth-strategies/` — `jwt-stateless` (JWT + rotating refresh token w/ reuse detection) and `session-redis` (Redis session + cookie).
- `src/rbac-strategies/` — `embedded-claims` (baked claims) and `db-live` (live lookup + 5s cache).

### What's left

- **Wave 5** — `guards-decorators-agent` (`@Public`/`@Roles`/`@Permissions`/`@CurrentUser` + `AuthGuard`/`RbacGuard`) then `auth-api-agent` (`modules/auth/` REST controller + `AuthService` + `PasswordService`).
- **Wave 6** — `rbac-admin-api-agent` (runtime role/permission CRUD + seed) ∥ `graphql-parity-agent`.
- **Wave 7** — `security-hardening-agent` (helmet/CORS/CSRF/throttler/lockout).
- **Wave 8** — `frontend-kit-agent` ∥ `test-agent` (unit + e2e).

## How to resume

1. Read `.agents/plan/MEMORY.md` (checkpoint + decisions) and `CONTRACTS.md` (§10 has the frozen constructor signatures).
2. Dispatch the next wave's agents as subagents, each given `STYLE.md` + the relevant `CONTRACTS`/`plan.md` slice, respecting owned-paths only and frozen signatures.
3. Run a per-wave conformance check (`pnpm build` + `pnpm test` green, owned paths respected) before the following wave.
