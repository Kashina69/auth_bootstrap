# auth — NestJS Auth + RBAC Bootstrap

Drop-in, DB-backed, ORM-agnostic authentication + RBAC module for NestJS 12 (Fastify).

## Current state + how to resume (waves 1–6 of 8 done; verified 2026-09-14)

**To resume:** read `.agents/plan/MEMORY.md` (running build log + latest checkpoint) first,
then dispatch Wave 6's agents as subagents per `plan.agent.md` §3 — each given `STYLE.md`
plus the relevant `CONTRACTS.md`/`plan.md` slice, restricted to its owned paths, with the
frozen signatures in `CONTRACTS.md` §10 unchanged. Run the per-wave conformance check
(`pnpm build` + `pnpm test` green, owned paths respected) before dispatching the wave after.
No `src/` scanning is needed to pick this up — these docs are the source of truth.

**Gate at this checkpoint:** `pnpm build` exit 0 · `pnpm test` 10 files / 74 tests passed ·
`pnpm exec tsc --noEmit` clean · `pnpm exec oxlint src/ test/` clean · **app boots** (GraphQL
on Fastify + all 12 REST routes mapped).

The build is driven by a multi-agent plan under `.agents/plan/`:

- `plan.md` — the architecture (pluggable strategies, schema, `rbac-core`, REST+GraphQL parity)
- `implementation.spec.md` — the security-critical code spec (argon2, JWT pinning, refresh rotation, `can()`, guards, env validation, multi-ORM)
- `plan.agent.md` — the orchestrator + subagent wave schedule
- `CONTRACTS.md` — the frozen interfaces (DI tokens, repository contracts, strategy constructors)
- `STYLE.md` — the binding code-style contract
- `MEMORY.md` — the running build log + decisions + latest checkpoint

### What exists

- `src/config/` — zod-validated env (`AUTH_STRATEGY`, `RBAC_STRATEGY`, `DB_PROVIDER`), fail-fast boot.
- `src/common/` — DI tokens, exception filter, redacting/logging + transform + timeout interceptors.
- `src/database/` — six-table schema + four repository contracts with **Prisma / Drizzle / Sequelize / Mongoose** adapters behind a `DB_PROVIDER` switch.
- `src/rbac-core/` — framework-agnostic `can()`/`hasRole()`/`hasAnyPermission()` (zero deps).
- `src/auth-strategies/` — `jwt-stateless` (JWT + rotating refresh token w/ reuse detection) and `session-redis` (Redis session + cookie).
- `src/rbac-strategies/` — `embedded-claims` (baked claims) and `db-live` (live lookup + 5s cache).
- `src/common/decorators/` + `src/common/guards/` — `@Public`/`@Roles`/`@Permissions`/`@CurrentUser`, `AuthGuard` (REST + GraphQL) and `RbacGuard` (deny-by-default).
- `src/common/security/` — `PasswordService` (argon2id, spec §1 params).
- `src/modules/auth/` — `AuthService` + DTOs + REST controller (`POST /auth/register|login|refresh` public, `POST /auth/logout` guarded), wired into `src/app.module.ts`.

### What's left

- **Wave 7** — `security-hardening-agent` (helmet/CORS/CSRF, per-route throttler, brute-force lockout, GraphQL depth/complexity limits — the `@Throttle()` metadata already on the auth routes is inert until this lands).
- **Wave 8** — `frontend-kit-agent` ∥ `test-agent` (unit + e2e).

### Known open items (full detail in `MEMORY.md`)

- **DEFECT: `isSystem` permissions are deletable.** The service derives "baseline" from system-role grants, but plan §5 declares 7 baseline permissions while system roles grant only 5 — so `update:Post`, `delete:Post`, `read:User` can be deleted via `DELETE /rbac-admin/permissions/:id`. The DB column `is_system` already exists; CONTRACTS §5 just doesn't expose it on `Permission`. Fix is surfacing the column, not a migration.
- **Contract gaps (agents were correctly blocked, not negligent):** no users-of-a-role lookup, so plan §5.5's `invalidate()` fan-out is impossible for role-scoped mutations; and no detach-permission, so Phase 9's "CRUD" is incomplete for grants.
- **`logout` silently no-ops under `session-redis`** and **the session cookie is never attached** — both contract-level gaps, both inert under the default `jwt-stateless` + `embedded-claims` pairing. Security-relevant; do not ship `session-redis` without resolving them.
- **No `auth.guard.spec.ts`** — `AuthGuard`'s `@Public()` bypass and its `req.user = user` assignment are untested (Wave 8 closes this).
- **`@nestjs/throttler@6.5.0` declares peers for Nest `^7–^11`** but this project is Nest 12 — Wave 7 will likely need to upgrade it before `ThrottlerGuard` can be registered.
- **`autoSchemaFile` writes `src/schema.gql`** on every boot, requiring a writable `src/` in production.
- `@Roles`/`ROLES_KEY` is deliberately kept but enforced by nothing; authorization runs through `@Permissions()` + `can()`.
