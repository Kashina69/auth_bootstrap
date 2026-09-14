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
| 5 | guards-decorators-agent ∥ auth-service-agent ∥ auth-http-agent → integration-agent | ✅ done (2026-09-14) |
| 6 | rbac-admin-agent ∥ graphql-parity-agent → wave6-verifier | ✅ done (2026-09-14) |
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

### Checkpoint — re-verified (2026-09-14)

No code or interface changes since the 2026-09-11 checkpoint; the working tree is clean at
commit `bce32e4`. State re-confirmed by re-running the gate:

- `pnpm build` → exit **0**.
- `pnpm test` → exit **0**, **6 files / 48 tests passed**.
- `grep -rn NotImplementedException src/` → **no matches**. All four Wave 4 strategy folders
  (`auth-strategies/jwt-stateless`, `auth-strategies/session-redis`,
  `rbac-strategies/embedded-claims`, `rbac-strategies/db-live`) are implemented, not stubs.
- Spot-verified the recorded decisions still hold in code: `IAuthStrategy.login(user, meta)`
  (Design B), and `JwtStatelessAuthStrategy(refreshTokens, users, jwt, config)` matching
  CONTRACTS §10; `UserRepository.assignRole` present.

No new decisions and no new open items — the open-items list above is unchanged and current.
Wave 5 remains **not dispatched**. Nothing in this re-verification alters the frozen
interfaces in CONTRACTS.md.

### Wave 5 decisions (orchestrator, 2026-09-14)

Wave 5 was dispatched as **three concurrent agents + one integration agent**, not the
sequential pair the Wave 4 checkpoint anticipated. Concurrency was safe because every
interface the three share was already frozen and pinned in each dispatch prompt:

- `guards-decorators-agent` → `src/common/decorators/`, `src/common/guards/`
- `auth-service-agent` → `src/common/security/`, `src/modules/auth/auth.service.ts`, `dto/`
- `auth-http-agent` → `src/modules/auth/auth.controller.ts`, `auth.module.ts`
- `integration-agent` (after) → `src/app.module.ts` wiring + 3 pre-existing type errors

No two agents shared a file, so `owned-paths only` held without coordination.

- **Dependency installs (orchestrator, outside all owned paths).** Two gaps blocked a
  verbatim implementation: `@nestjs/graphql` + `graphql` were absent though spec §5
  mandates the `GqlExecutionContext` branch (**user decision: install now**), and `argon2`
  was absent though spec §1 names it explicitly. Installed `@nestjs/graphql@14.0.0`,
  `graphql@17.0.2`, `argon2@0.45.1`. **argon2's native build was blocked by pnpm's
  allowlist** — the placeholder `argon2: set this to true or false` in `pnpm-workspace.yaml`
  was flipped to `true`, and a real `hash`/`verify` round-trip was confirmed before dispatch.
- **`@Roles` / `ROLES_KEY` has no consumer — accepted, deliberately kept.** STYLE.md says
  delete unused hooks; `plan.md` §11 Phase 8 explicitly lists `@Roles` as a deliverable of
  this phase and it is frozen in CONTRACTS §1. The spec deliverable wins. A
  `@Roles()`-decorated route is therefore NOT enforced by any guard — enforcement is
  `@Permissions()` + `can()` only. Documented in `roles.decorator.ts`.
- **`.js` extensions on every relative import** — mandatory (ESM/NodeNext) and the only
  permitted deviation from the spec §5 snippets. Also `'../../rbac-core/index.js'` rather
  than the spec's bare `'../../rbac-core'` (NodeNext cannot resolve the bare directory).
- **Thin `AuthController`, no business logic.** Controller builds `RequestMeta` from
  `@Req() request: FastifyRequest` (`request.ip`, `request.headers['user-agent']`) — no
  Express-only APIs. `AuthModule` imports nothing; it relies on the four `@Global()` modules.
- **`tsc --noEmit` is now part of the gate.** `pnpm build` uses `tsconfig.build.json` (which
  excludes specs) and vitest transpiles without typechecking, so three latent type errors
  had accumulated invisibly — including a Wave 4 fake `UserRepository` missing the
  `assignRole` added that wave. All three fixed; `tsc --noEmit` is clean.
- **Wave 5 service signatures are frozen but NOT yet in CONTRACTS.md** (deliberate — the
  no-touch instruction applied, since no *existing* frozen interface changed):

  ```ts
  // src/common/security/password.service.ts
  class PasswordService { hash(p: string): Promise<string>; verify(h: string, p: string): Promise<boolean>; }
  // src/modules/auth/auth.service.ts
  class AuthService {
    register(dto: RegisterDto, meta: RequestMeta): Promise<AuthResult>;
    login(dto: LoginDto, meta: RequestMeta): Promise<AuthResult>;
    refresh(dto: RefreshDto, meta: RequestMeta): Promise<AuthResult>;
    logout(user: AuthenticatedUser, sessionRef: unknown): Promise<void>;
  }
  ```

  Recommend promoting these into a CONTRACTS §11 before Wave 6 codes against them.

### Checkpoint — end of Wave 5 (2026-09-14)

Gate, independently re-run by the orchestrator after all four agents stopped:

- `pnpm build` → exit **0**
- `pnpm test` → exit **0**, **9 files / 64 tests passed** (was 6/48 before Wave 5)
- `pnpm exec tsc --noEmit -p tsconfig.json` → exit **0**, zero errors (was 3)
- `pnpm exec oxlint src/ test/` → exit **0**, 0 warnings / 0 errors

`AuthModule` is now wired into `src/app.module.ts`. REST surface: `POST /auth/register`,
`POST /auth/login`, `POST /auth/refresh` (all `@Public()`), `POST /auth/logout`
(`@UseGuards(AuthGuard, RbacGuard)`). All Wave 5 agents respected owned paths — `git status`
shows no stray files.

An independent `conformance-verifier` agent audited the wave against spec §5/§1/§3/§6,
CONTRACTS §9 and STYLE.md: **15/16 checks PASS**, the one FAIL being the accepted `@Roles`
question above. Notably it confirmed the security invariants *by execution* rather than by
comment — including that the absent-user login path really does run a full argon2 KDF
(`ABSENT_USER_HASH` is a genuine argon2id hash, awaited before the null check).

Waves 1–5 complete and verified. **Wave 6 is NOT yet dispatched.**

Open items / risks (Wave 5 additions first):

- **`logout` silently no-ops under `session-redis`.** `SessionRedisAuthStrategy.logout()`
  gates on `isSessionRef(sessionRef)` requiring a non-empty **string**, but
  `IAuthStrategy.logout(userId, sessionRef: unknown)` is written so the *strategy* interprets
  its own transport, and `AuthController` passes the raw `FastifyRequest`. Consequence: the
  session is never invalidated. The fix belongs in the strategy (read its own cookie), NOT in
  the controller — importing `readSessionId` into the controller would hard-wire one concrete
  strategy into a transport-agnostic layer and break the deletable-folder property. Needs an
  orchestrator/contract decision; not fixed in Wave 5. **Security-relevant.**
- **The session cookie is never attached.** `SessionRedisAuthStrategy.login()` returns the
  sid via `AuthResult.refreshToken`, and its doc comment says the auth service attaches it via
  `createSessionCookieOptions()` — but `IAuthStrategy.login(user, meta)` has no response
  handle and no caller does it. So cookie-only refresh cannot work under `session-redis`.
  Also a contract-level decision, not a controller fix.
  - Both above are **inert under the default pairing** (`jwt-stateless` + `embedded-claims`).
- **No `auth.guard.spec.ts`.** `AuthGuard`'s `@Public()` bypass, its `UnauthorizedException`
  path, and the security-critical `req.user = user` assignment (which `RbacGuard` and
  `@CurrentUser()` both depend on) have **zero test coverage**. `rbac.guard.spec.ts` covers the
  RBAC half only. Test wave (Wave 8) should close this.
- **Spec §6 brute-force lockout + throttler are NOT wired** — confirmed by `plan.md` §11
  Phase 11 ("throttler tuning per-route, brute-force lockout") = **Wave 7**. The `@Throttle()`
  metadata on the auth routes is inert until then. Expected, not a Wave 5 gap.
- **GraphQL branch is currently unreachable** — real and statically imported in both guards
  and `@CurrentUser()`, but `GraphQLModule` is registered nowhere, so `context.getType()` can
  never return `'graphql'`. Wave 6 makes it live. Comments in the controller and DTOs that
  refer to the GraphQL half in the present tense are anticipatory and become true in Wave 6.
- **Mongoose normalizes email inside its adapter; Prisma/Drizzle/Sequelize do not.**
  `AuthService.normalizeEmail` at the boundary makes this harmless today, but it contradicts
  spec §9's "every adapter implements it identically". Pre-existing (Wave 2), not a Wave 5
  regression.

Carried forward from Wave 4 (still open): Prisma migration path; `DB_PROVIDER=mongoose`
reuses `DATABASE_URL`; Mongoose ObjectIds vs UUID strings; `rbac-core` `hasRole`/
`hasAnyPermission` have no null-guard; Redis/Postgres live paths untested.

### Wave 6 decisions (orchestrator, 2026-09-14)

Dispatched as **2 concurrent agents** (down from Wave 5's 3 build + 1 integration + 1
verifier), per the cost directive. Each agent owns a whole vertical, so neither depends on
the other. **`app.module.ts` / `auth.module.ts` wiring was done by the orchestrator**, not an
agent — it is 3 lines and cost 47k as an agent in Wave 5.

- **GraphQL driver: Apollo (code-first)** per plan.md §10 + line 33 and §11 Phase 10.
  Installed `@nestjs/apollo@14.0.0`, `@apollo/server@5.5.1`, `@as-integrations/fastify@3.1.0`.
- **graphql pinned 17.0.2 → 16.14.2.** `@apollo/server@5.5.1` peer-requires `graphql@^16.11.0`
  while `@nestjs/graphql` accepts `^16.11.0 || ^17.0.0`; 16.x is the only version satisfying
  both. The Wave 5 install of graphql 17 had to be walked back.
- **`@as-integrations/fastify` is mandatory, not optional** — `@nestjs/apollo`'s Fastify path
  calls `loadPackage('@as-integrations/fastify')` at driver start; without it `GraphQLModule`
  throws at boot. `@apollo/protobufjs`'s build script is a version nag, so it is set `false`
  in `pnpm-workspace.yaml`.
- **GraphQL depth/complexity limiting deferred to Wave 7** (plan.md line 359). Not hand-rolled.
- **`tsx` added as a devDep** for `seed:rbac` — `node --experimental-strip-types` cannot
  resolve this project's `.js`→`.ts` ESM specifiers (reproduced by the verifier).
- **`autoSchemaFile` points at `src/schema.gql`** — the app writes into the source tree on
  every boot, which requires a writable `src/` in production. Noted, not yet changed.

### Checkpoint — end of Wave 6 (2026-09-14)

Gate (orchestrator, after wiring): `pnpm build` exit **0**; `pnpm test` exit **0**,
**10 files / 74 tests passed**; `pnpm exec tsc --noEmit` exit **0**; `pnpm exec oxlint src/ test/`
exit **0**. **Boot verified for the first time** — a real `node dist/main.js` run mapped
`/graphql` (POST), 4 `/auth/*` routes and 8 `/rbac-admin/*` routes, and logged
"Nest application successfully started". This closes the Wave 5 open item where the guards'
GraphQL branch was unreachable dead code.

`AuthModule` now also provides `AuthResolver`; `GraphqlModule` + `RbacAdminModule` are wired
into `src/app.module.ts`.

### DEFECT found by the Wave 6 verifier — `isSystem` permissions are deletable

**F1 (real defect, open).** `rbac-admin.service.ts` derives "baseline permission" as *"granted
by some `isSystem` role"*. That heuristic is unsound against plan §5's own seed JSON: it
declares 7 baseline permissions but the system roles grant only 5, so **`update:Post`,
`delete:Post` and `read:User` are declared baseline yet deletable** — directly violating
plan §5.4 ("`is_system = true` roles/permissions from the JSON are protected from deletion").
The service comment asserting "the baseline is exactly what the seeded system roles grant" is
false, and `rbac-admin.service.spec.ts` encodes the flawed behaviour as a passing test.

Corollary: attaching a runtime-created permission to a system role makes it permanently
undeletable, because no detach method exists to undo the grant.

**Root cause is a half-wired column, not a missing feature:** the DB already has
`is_system BOOLEAN NOT NULL DEFAULT false` (migration line 22, `schema.prisma:43`,
`drizzle/schema.ts:21`) — but the `Permission` interface in CONTRACTS §5 does not expose it,
so the repositories drop it and the service had nothing to read. The fix is to surface an
already-existing column, not a migration.

**Also confirmed as genuine contract gaps** (not skipped work — the agents were correctly
blocked, not negligent):
- **No users-of-a-role lookup** in CONTRACTS §5, so plan §5.5's `invalidate()` fan-out is
  impossible for `attachPermissions`/`deleteRole`. Fix: add e.g.
  `UserRepository.findUserIdsByRole(roleId)` (+4 adapters).
- **No detach-permission** in `RoleRepository` — `attachPermissions` is strictly additive, so
  Phase 9's "CRUD" is incomplete at the contract level. Interacts with F1 as above.

**Verifier nitpicks (minor, not defects):** `requestMeta` and the three rate-limit constants
are copy-pasted between `auth.controller.ts` and `auth.resolver.ts`; plan §5's JSON is
internally inconsistent in the other direction too (`admin` grants `manage:Post`, which
`permissions[]` never declares).

**Cost note (honest):** the diff-scoped verifier cost **59.8k vs Wave 5's 68k full-tree** —
a smaller saving than intended, because Wave 6's diff *is* most of the new code, so scoping
to the diff still meant reading nearly everything. `rbac-admin-agent` cost 118.9k, roughly
double the per-agent average, being a whole vertical. Wave 6 agent total ≈ 235k vs Wave 5's
292k.
