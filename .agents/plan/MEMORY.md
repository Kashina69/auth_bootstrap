# MEMORY.md — Running Build Log

Updated by the orchestrator after each wave (never by workers — avoids write races).

## Decisions locked at kickoff (2026-09-11)

- **Scope:** full 8-wave build (all 4 strategies, Redis, GraphQL, rbac-admin, hardening,
  tests).
- **ORM surface:** Prisma + Drizzle + Sequelize + **Mongoose**. Note: Mongoose (MongoDB)
  replaces the plan's TypeORM. The source-of-truth schema is relational (PostgreSQL);
  the Mongoose adapter implements the same repository contracts against Mongo
  collections — a document-model adapter, not a schema change. Cross-check: `plan.md` §4
  uses `citext`/`jsonb`/FK joins that have no direct Mongo equivalent; adapter must
  normalize to the same repository interface + `null`-on-not-found.
- **Defaults (§12):** `AUTH_STRATEGY=jwt-stateless` + `RBAC_STRATEGY=embedded-claims`;
  db-live cache TTL 5–10s; ABAC-lite (`role_permission_conditions`) deferred to v1.1.
- **Orchestration:** multi-agent wave schedule per `plan.agent.md` §3.

## Waves

| Wave | Agents | Status |
|------|--------|--------|
| 1 | scaffold-agent | ✅ done (2026-09-11) |
| 2 | db-schema-agent ∥ rbac-core-agent ∥ orm-adapters-agent | ✅ done (2026-09-11) |
| 3 | strategy-interfaces-agent | ✅ done (2026-09-11) |
| 4 | auth-jwt-agent ∥ auth-session-agent ∥ rbac-embedded-agent ∥ rbac-dblive-agent | ✅ done (2026-09-11) |
| 5 | guards-decorators-agent → auth-api-agent | ⏳ pending (not yet dispatched) |
| 6 | rbac-admin-api-agent ∥ graphql-parity-agent | pending |
| 7 | security-hardening-agent | pending |
| 8 | frontend-kit-agent ∥ test-agent | pending |

## Deviations / notes

### Wave 2 reconciliation (orchestrator, 2026-09-11)

- **Email = plain text, case-normalized at the service boundary** (was `citext` in Drizzle
  + Sequelize, plain text in Prisma). Aligned all four adapters to plain text so Mongo
  (no `citext`) is first-class. The auth service MUST lowercase email before
  `findByEmail`/`create` — recorded for Wave 4.
- **Soft-delete filter added to Drizzle/Sequelize/Mongoose `findById`/`findByEmail`** —
  Prisma already filtered `deletedAt: null`; the other three did not (a deactivated
  account could still authenticate). Now consistent across all four.
- **`DB_PROVIDER` switch fully wired** in `database/database.module.ts` for all four
  adapters. `createMongooseClient` is async (Nest resolves the promise).
- **Prisma pinned to 6.19.3** (v7 needs a root `prisma.config.ts` + driver adapter, outside
  the `src/` owned paths).
- **Migration path caveat:** migration SQL is at `src/database/migrations/` (per plan §2),
  but Prisma's tooling expects it as a sibling of `schema.prisma`
  (`src/database/prisma/migrations/`). Apply via `psql -f` or move it later.
- **`DB_PROVIDER=mongoose` uses `DATABASE_URL` as its Mongo URI** — the zod schema accepts
  any URL, so set `DATABASE_URL` to a `mongodb://` URI in that mode.
- **`pnpm-workspace.yaml`** was created by db-schema-agent (justified: `allowBuilds` had
  placeholder values blocking `pnpm install`).
- `rbac-core` `hasRole`/`hasAnyPermission` have no null-guard (only `can()` does) — accepted;
  `can()` is the sole deny-gate used by `RbacGuard`.

### Wave 3 decisions (orchestrator, 2026-09-11)

- **Design B adopted for auth strategies.** `IAuthStrategy.login` now takes
  `user: AuthenticatedUser` (was `credentials: LoginDto`). The auth service
  (`modules/auth/`) does credential lookup + password verification and passes the verified
  user to the strategy, which only issues/validates the session. This matches the frozen
  constructors (`JwtStatelessAuthStrategy(refreshTokens, jwt, config)` — no UserRepository/
  PasswordService). CONTRACTS §3 updated.
- **Plan gap: no agent owns `modules/auth/`** (REST controller + `AuthService` + DTOs +
  `PasswordService`). Added `auth-api-agent` to Wave 5 (parallel with guards-decorators).
- Frozen constructor signatures live in CONTRACTS §10 (unchanged from Wave 3).
- `NotImplementedException` used for stubs (Nest idiom), `REDIS_CLIENT` provided
  per-module (two ioredis connections only if BOTH session-redis and db-live active —
  acceptable; default pairing uses neither), `JwtService` not exported from
  AuthStrategiesModule (Wave 5/6 auth module will import JwtModule itself).

### Wave 4 decisions (orchestrator, 2026-09-11)

- **Refresh rework.** The frozen `JwtStatelessAuthStrategy` constructor was too thin —
  `refresh()` could not rebuild email/flags/RBAC claims from an opaque refresh token, so
  the agent's initial carry-forward approach left stale claims past refresh (violating
  plan §3.3). Fixed by adding `UserRepository` to the constructor; `refresh()` now
  re-resolves identity + claims fresh. CONTRACTS §10 updated; `verifyExpiredAccessToken`
  removed (no relaxed-expiry path).
- **Added `assignRole(userId, roleId)` to `UserRepository`** (register must assign the
  default role; no method existed). Idempotent across all four adapters (Prisma upsert,
  Drizzle onConflictDoNothing, Sequelize findOrCreate, Mongoose $addToSet). CONTRACTS §5
  updated.
- **Session-redis deviations accepted:** cookie `path=/` (not `/auth/refresh`) — the
  session cookie is the sole credential and must ride every guarded route; full
  `AuthenticatedUser` snapshot stored in the session (constructor has no UserRepository),
  so deactivation/ban applies by deleting the session key.
- **db-live TTL = 5s** (module-local constant; `AppConfig` has no TTL getter).

### Checkpoint — end of Wave 4 (2026-09-11)

Build: `pnpm build` exit **0**. Tests: **6 files / 48 passed**. No `NotImplementedException`
stubs remain under `src/auth-strategies/` or `src/rbac-strategies/`.

Waves 1–4 complete and verified. **Wave 5 is NOT yet dispatched.** Next wave =
`guards-decorators-agent` (owns `src/common/decorators/` + `src/common/guards/`; implement
spec §5 AuthGuard/RbacGuard verbatim), then `auth-api-agent` (owns `src/modules/auth/` +
`src/common/security/` — PasswordService + AuthService + REST controller), which depends on
the guards/decorators output, so it runs second.

Decisions in force (full rationale above): Design B `login(user)`; plain-text email +
service-boundary case-normalization; frozen constructor signatures in CONTRACTS §10
(`JwtStatelessAuthStrategy(refreshTokens, users, jwt, config)`); `DB_PROVIDER =
prisma|drizzle|sequelize|mongoose`; `assignRole` added to `UserRepository`.

Open items / risks:
- **Auth-service email normalization not yet implemented** — Wave 5b auth service MUST
  lowercase email before `findByEmail`/`create` (Mongo normalizes internally; Prisma/
  Drizzle/Sequelize do not).
- **`JwtService` not exported** from `AuthStrategiesModule` — the auth service should NOT
  touch JWT directly (it only calls `IAuthStrategy`), so this is likely fine.
- **Prisma migration path** — `src/database/migrations/` is not auto-discovered by
  `prisma migrate`; apply via `psql -f` or move to `src/database/prisma/migrations/`.
- **`DB_PROVIDER=mongoose`** reuses `DATABASE_URL` as the Mongo URI (documented).
- **Mongoose IDs are ObjectIds** (not the UUID strings the app uses) — the Mongoose adapter
  is best-effort for UUID-string callers; documented, not a Wave-5 blocker.
- **Session-redis stores a full user snapshot** — deactivation applies by deleting the
  session key (admin forced-logout is a later wave).
- **Redis/Postgres live paths untested** — unit tests use mocks; e2e (Wave 8) will need
  live services or further mocking.
