# WAVE-LOG.md — Per-wave ledger

Append-only history of every wave: agents, token cost, gate results, defects, security
findings, open items. **Purpose:** let an external validation pass (run in a separate chat)
assess completion and security against `plan.md` / `implementation.spec.md` without
re-scanning `src/`.

Maintained by the orchestrator at the end of every wave. Never renumber or rewrite history —
appended entries are immutable; corrections are added as dated amendments.

**Per-agent token figures exist only from Wave 5 onward** — Waves 1–4 ran in an earlier
session and their per-agent usage was not recorded. That gap is permanent; do not invent
numbers to fill it.

---

## Wave 1 — scaffold-agent ✅ (2026-09-11)

| Agent | Task | Tokens |
|---|---|---|
| scaffold-agent | NestJS scaffold, Fastify, zod env, interceptors/filters, Vitest wiring | not recorded |

Gate: build 0, 6 files / 48 tests (as of Wave 4 checkpoint). Defects: none recorded.

## Wave 2 — db-schema-agent ∥ rbac-core-agent ∥ orm-adapters-agent ✅ (2026-09-11)

| Agent | Task | Tokens |
|---|---|---|
| db-schema-agent | 6-table schema + migration + 4 repository contracts | not recorded |
| rbac-core-agent | zero-dep `can()`/`hasRole()`/`hasAnyPermission()` | not recorded |
| orm-adapters-agent | Prisma/Drizzle/Sequelize/Mongoose adapters behind `DB_PROVIDER` | not recorded |

Decisions: email = plain text + service-boundary normalization (Mongo has no `citext`);
soft-delete filter added to 3 adapters; Prisma pinned 6.19.3.
Known limitation: `rbac-core.hasRole`/`hasAnyPermission` have no null-guard (only `can()`).

## Wave 3 — strategy-interfaces-agent ✅ (2026-09-11)

Froze `IAuthStrategy` / `IAuthorizationProvider` / factory `inject` arrays (CONTRACTS §10).
Decision: **Design B** — `login(user: AuthenticatedUser, meta)`, service verifies credentials.

## Wave 4 — auth-jwt ∥ auth-session ∥ rbac-embedded ∥ rbac-dblive ✅ (2026-09-11)

Four strategy implementations. Decisions: refresh rework (constructor gained `UserRepository`);
`assignRole` added to `UserRepository`; session cookie `path=/`; db-live TTL 5s.

Gate at Wave 4 checkpoint: build 0, **6 files / 48 tests**. No `NotImplementedException` stubs.

---

## Wave 5 — guards, decorators, auth service + REST API ✅ (2026-09-14)

Model: 3 concurrent build agents + 1 integration + 1 verifier. **Total ≈ 292k.**

| Agent | Task | Tokens | Tool calls | Duration |
|---|---|---|---|---|
| guards-decorators-agent | `@Public/@Roles/@Permissions/@CurrentUser`, `AuthGuard`, `RbacGuard` | 36.4k | 23 | 65s |
| auth-service-agent | `PasswordService` (argon2id), `AuthService`, DTOs | 73.2k | 45 | 155s |
| auth-http-agent | REST controller + module | 67.2k | 32 | 111s |
| integration-agent | `app.module.ts` wiring + 3 latent type fixes | 47.5k | 31 | 110s |
| conformance-verifier | full-tree audit vs spec §5/§1/§3/§6, CONTRACTS §9, STYLE | 68.0k | 40 | 89s |

**Gate:** build 0 · `pnpm test` 9 files / 64 passed · `tsc --noEmit` **0** (was 3) · oxlint 0.
Boot not yet performed at this checkpoint.

**Dependencies resolved by orchestrator (pre-flight):** `@nestjs/graphql@14.0.0` + `graphql`
(initially 17.0.2) for the spec §5 GraphQL branch; `argon2@0.45.1` (spec §1) — native build
allowlisted in `pnpm-workspace.yaml`, round-trip verified.

**Defects / findings:**
- **3 latent type errors** invisible to build+test (tsconfig.build excludes specs; vitest does
  not typecheck) — incl. a Wave 4 fake `UserRepository` missing `assignRole`. Fixed.
  → `tsc --noEmit` made a permanent part of the gate.
- **Verifier: 15/16 PASS.** Sole FAIL was `@Roles` having no consumer — escalated, not a
  defect: `plan.md` §11 Phase 8 mandates the decorator, so STYLE's "delete unused" yields.
- **`logout` silently no-ops under `session-redis`** (strategy gates on a string ref, controller
  passes the request). **Session cookie never attached** under `session-redis`. Both
  contract-level, both inert under the default pairing. **SECURITY-RELEVANT, still open.**
- No `auth.guard.spec.ts` — `@Public()` bypass and `req.user = user` untested. Still open.
- GraphQL branch in the guards was unreachable (no `GraphQLModule`). Closed in Wave 6.

## Wave 6 — rbac-admin API, seed, GraphQL parity ✅ (2026-09-14)

Model: 2 concurrent verticals, orchestrator did the wiring, 1 diff-scoped verifier, then a
fix round. **Total ≈ 353k — more than Wave 5 despite fewer agents (scope, not agent count).**

| Agent | Task | Tokens | Tool calls | Duration |
|---|---|---|---|---|
| rbac-admin-agent | rbac-admin vertical (service/REST/resolver/DTOs) + idempotent seed | 118.9k | 100 | 412s |
| graphql-parity-agent | Apollo code-first bootstrap + auth resolver + DTO decorators | 56.0k | 50 | 125s |
| wave6-verifier | diff-scoped audit (10 checks) | 59.8k | 28 | 62s |
| contract-fix-agent | F1 fix + 2 contract gaps across 12 adapters + service + seed + tests | 118.2k | 123 | 298s |

**Gate:** build 0 · `pnpm test` 10 files / 74 passed (77 after the fix) · `tsc --noEmit` 0 ·
oxlint 0 · **boot verified** (`/graphql` + 12 REST routes mapped).

**Dependencies (pre-flight):** `@nestjs/apollo@14.0.0`, `@apollo/server@5.5.1`,
`@as-integrations/fastify@3.1.0`; **graphql pinned 17.0.2 → 16.14.2** (`@apollo/server@5`
peer-requires `^16`). `@as-integrations/fastify` is **mandatory** — the Apollo driver throws
at boot without it.

**Defects / findings:**
- **F1 (SECURITY-RELEVANT, FIXED):** baseline permissions were deletable via
  `DELETE /rbac-admin/permissions/:id`. The service derived baseline-ness from system-role
  grants, but plan §5 declares 7 baseline permissions while system roles grant 5 — so
  `update:Post`, `delete:Post`, `read:User` were deletable, violating plan §5.4. The agent's
  own spec **encoded the bug as a passing test**, and a comment asserted the false rule.
  Fixed by adding a real `is_system` column on `permissions` (migration), exposing
  `Permission.isSystem`, and deleting the heuristic. Tests replaced (not deleted); verified by
  **mutation check** (forcing the guard false fails exactly the 2 baseline tests).
- **Orchestrator error, corrected:** the orchestrator claimed the `is_system` column already
  existed and no migration was needed. **False** — all three grep hits were on `roles`. Sent
  the fix round in the wrong direction until the agent disproved it. Recorded in MEMORY.md.
- **Contract gaps (fixed):** no users-of-a-role lookup (blocked plan §5.5 `invalidate()`
  fan-out) and no detach-permission (Phase 9 "CRUD" incomplete). Both added to CONTRACTS §5.
- Minor: `requestMeta` + rate-limit constants duplicated between controller and resolver;
  `autoSchemaFile` writes `src/schema.gql` on every boot.

---

## Current project status (as of Wave 6, HEAD `06dfc6f`)

Waves 1–6 of 8 complete. Gate: build 0 · test **10 files / 77 passed** · `tsc --noEmit` 0 ·
oxlint 0 · boot verified.

### Open security items (for the validation pass)

| # | Item | Severity | Status |
|---|---|---|---|
| S1 | `logout` no-ops under `session-redis` — session never invalidated | High (if session-redis shipped) | **OPEN** |
| S2 | Session cookie never attached under `session-redis` — cookie-only refresh impossible | High (if session-redis shipped) | **OPEN** |
| S3 | Baseline permission deletion (F1) | High | FIXED + mutation-verified |
| S4 | `auth.guard.spec.ts` absent — `@Public()` bypass, `req.user = user` untested | Medium | OPEN (Wave 8) |
| S5 | Brute-force lockout + throttler not wired (spec §6) | High | Deferred to Wave 7 by plan §11 Phase 11 |
| S6 | GraphQL depth/complexity limiting absent (plan line 359) | Medium | Deferred to Wave 7 |
| S7 | `@nestjs/throttler@6.5.0` peers are Nest `^7–^11`, project is Nest 12 | Blocking for Wave 7 | OPEN — check first |
| S8 | `rbac-core.hasRole`/`hasAnyPermission` lack the null-guard `can()` has | Low | Accepted (only `can()` gates) |
| S9 | `deletePermission` does not fan out `invalidate()` | Low | OPEN (needs another contract method) |
| S10 | Mongoose normalizes email in-adapter; the other 3 do not (spec §9 "identical") | Low | OPEN, pre-existing |
| S11 | Seed `findOrCreatePermission` never updates — old rows keep `is_system = false` | Low | OPEN (no contract method to backfill) |
| S12 | `autoSchemaFile` requires a writable `src/` in production | Low | OPEN |

### Deferred / not yet built

- **Wave 7** — `security-hardening-agent`: helmet/CORS/CSRF finalization, per-route throttler,
  brute-force lockout (spec §6), GraphQL depth/complexity limits (plan line 359).
- **Wave 8** — `frontend-kit-agent` ∥ `test-agent`: unit + e2e, `/auth/me` + `/authz/check`,
  React `usePermission()`.

### Carried from Wave 4 (still open)

Prisma migration path (now two migrations); `DB_PROVIDER=mongoose` reuses `DATABASE_URL`;
Mongoose ObjectIds vs UUID strings; Redis/Postgres live paths untested.
