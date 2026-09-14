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
| 7 | rate-limit-agent ∥ transport-hardening-agent → gql-context-fix-agent → throttler-graphql-agent | ✅ done (2026-09-14) |
| 8 | frontend-kit-agent ∥ test-agent | ✅ done (2026-09-14) — built **inline by the orchestrator, no agents dispatched** (see Wave 8)

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

**Root cause: `permissions` had no `is_system` column at all.** The orchestrator initially
claimed the column already existed and that no migration was needed — **that was wrong.** The
three cited hits are all on the **`roles`** table (`CREATE TABLE "roles"` at
`migration.sql:22`, `Role.isSystem` at `schema.prisma:43`, `roles.isSystem` at
`drizzle/schema.ts:21`); the `permissions` block (lines 30-39) has no such column, and `Role`
already exposed `isSystem` in CONTRACTS §5 precisely because its column existed. The misread
came from grepping `is_system|isSystem` and not checking which table each hit belonged to.
The `contract-fix-agent` disproved it twice: by reading the migration block, and by `tsc`
rejecting the widened `Permission` against the Drizzle select/insert and the generated Prisma
client.

### Fix applied (2026-09-14) — F1 closed

Contract additions were frozen by the orchestrator in CONTRACTS §5 first (workers must not
edit that file unilaterally), then implemented by one `contract-fix-agent`:

- `Permission.isSystem: boolean` + optional `isSystem` on `PermissionRepository.create`.
  **A migration WAS required and was added:**
  `src/database/migrations/20260914000000_permission_is_system/migration.sql`
  (`ALTER TABLE "permissions" ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;`), plus
  `Permission.isSystem @map("is_system")` in `schema.prisma`, `permissions.is_system` in
  `drizzle/schema.ts`, and the field on the Sequelize/Mongoose permission models.
- All four permission adapters return `isSystem`; so do the four **role** adapters, which
  build `Permission` objects in their permission mappers.
- `UserRepository.findUserIdsByRole(roleId)` + 4 adapters.
- `RoleRepository.detachPermissions(roleId, permissionIds)` (idempotent) + 4 adapters, each
  mirroring its own `attachPermissions` idiom.
- `rbac-admin.service.ts`: the grant-derived `isBaselinePermission` heuristic and its false
  comment are **deleted**; the guard now reads `permission.isSystem`. `invalidate()` fan-out
  wired for `attachPermissions`/`detachPermissions`/`deleteRole` — `deleteRole` captures
  holders via `findUserIdsByRole` **before** `roles.delete` (ordering is pinned by a test).
- `rbac.seed.ts`: a permission is baseline iff declared in `rbac.seed.json`'s `permissions[]`
  **or** granted by an `isSystem` role (union — the plan's JSON is inconsistent in both
  directions). `rbac.seed.json` itself left byte-identical to plan §5.
- New `DELETE /rbac-admin/roles/:id/permissions` + `detachPermissions` GraphQL mutation,
  same `@Permissions('manage:User')` / guard order / thin delegation as `attach`.
- The test that **encoded the bug** (`deletes a permission no system role grants`) was
  replaced by tests pinning correct behaviour: a declared baseline permission granted by no
  system role (`update:Post`) is NOT deletable; a runtime-created permission IS. Plus detach
  idempotency, per-holder fan-out, and the pre-delete capture ordering. Verified by mutation
  check — stubbing the `isSystem` guard to `false` fails exactly the two baseline tests.

Gate after the fix: build 0; `pnpm test` **10 files / 77 passed**; `tsc --noEmit` 0; `oxlint`
0; **boot re-verified** (`/graphql` mapped, "Nest application successfully started").

Two caveats recorded: (a) the seed's `findOrCreatePermission` never updates an existing row,
so any environment that already ran the old seed keeps `is_system = false` on those rows until
they are recreated — the contract has no permission-update method to backfill with; (b)
`deletePermission` does not fan out `invalidate()` (finding a permission's holders would need
another contract method), so only the three methods in §5.5 do.

Widening the interfaces broke every typed test double: `auth.service.spec.ts` and
`jwt-stateless.auth-strategy.spec.ts` each needed a one-line stub for the new methods.
Behaviour unchanged; without them the zero-error `tsc` gate is unmeetable.

### Wave 7 decisions (orchestrator, 2026-09-14)

Two concurrent agents, then a **defect chain of two more fix agents** — Wave 7 cost ≈ **339k**,
not because of scope but because each fix unmasked the next latent crash. Full per-agent table
in `WAVE-LOG.md`.

- **CORS posture:** deny-all by default; activates only when `CORS_ORIGINS` (optional,
  comma-separated) is set. `credentials: true` **only** under `session-redis`, because that is
  the only mode with an ambient cookie credential; off under `jwt-stateless`. Added via
  `@fastify/cors` **directly, not `app.enableCors()`** — the latter typechecks but crashes at
  boot, because `skipLibCheck` hides an unresolvable import inside `@nestjs/platform-fastify`.
- **Throttler works on Nest 12 — the peer range is stale metadata.** Empirically verified by
  the orchestrator *before* dispatching: `ThrottlerModule.forRoot` + `APP_GUARD` boot cleanly.
  Do not re-litigate this in Wave 8.
- **Lockout degrades explicitly.** `LoginAttemptService` injects its **own** Redis client gated
  on `AppConfig.REDIS_URL`, and does NOT inject `REDIS_CLIENT`. Reason: `@Global()` does not
  export a module's providers, so `REDIS_CLIENT` is genuinely not injectable from `AuthModule`
  (it is in `providers` of both strategy modules but never in `exports`), and the token is
  ambiguous anyway since both modules register it. `REDIS_URL` unset ⇒ no-op + one boot warning.
  Redis errors fail **open** (a dead Redis must not lock everyone out).
- **`logout`/lockout message stays byte-identical** — the single `INVALID_CREDENTIALS` constant
  covers absent user, wrong password, inactive account, *and* lockout.
- **GraphQL depth/complexity limits** (`depthLimit(10)`, complexity 1000) go through the Apollo
  driver's `validationRules`. Verified enforcing with a real query, not by reading config.
- **Deps added:** `@fastify/cors@11.3.0`, `graphql-depth-limit@1.1.0`,
  `graphql-query-complexity@2.0.0`, `@types/graphql-depth-limit@1.1.6` (dev).
- **New guard:** `src/common/guards/graphql-throttler.guard.ts` — subclasses `ThrottlerGuard`,
  overriding **only** `getRequestResponse`, registered as `APP_GUARD` in place of the stock guard.

### Checkpoint — end of Wave 7 (2026-09-14)

Gate (orchestrator, independently re-run): `pnpm build` exit **0** · `pnpm test` exit **0**,
**13 files / 94 tests passed** · `tsc --noEmit` exit **0** · `oxlint src/ test/` exit **0** ·
boots with **and** without `CORS_ORIGINS`.

**End-to-end HTTP, real `dist/main.js`:** guarded GraphQL `{ roles { id } }` → `Unauthorized`
(reaches the auth layer) · `{ __typename }` → 200 · **GraphQL `login` loop → throttled (3/8)** ·
REST `POST /auth/login` loop → **429 (3/8)**. The GraphQL-throttled result is the security-
critical one: GraphQL is **not** a rate-limit bypass.

### The GraphQL / global-middleware defect chain — the main lesson of Wave 7

**Three crashes, one root cause:** every globally-registered HTTP enhancer called
`context.switchToHttp()` unconditionally, which yields no request for a GraphQL context. All
three were latent since Wave 1 and only became reachable when Wave 6 registered `GraphQLModule`:

1. `LoggingInterceptor` (`request.method` on undefined) — Wave 1 file
2. `HttpExceptionFilter` (same; it crashed *before* writing a response, which **masked** #3)
3. Stock `ThrottlerGuard` — `getTracker()` read `req.ip` on undefined

**None was visible to `build`, `test`, `tsc`, `oxlint`, a clean boot, or an adversarial
code-reading verifier. Only executing a real resolver exposed them.** The gate now includes
real requests after boot — see `orchestrate-skill.md` §7.

**Security note on the tempting shortcut:** fixing #3 by *skipping* throttling for non-HTTP
contexts would have been a **brute-force bypass**, since `login`/`register`/`refresh` are
exposed as GraphQL mutations. The agent was forbidden from that route and required to prove a
real throttle over GraphQL. Rule recorded in `orchestrate-skill.md` §12a.

### Orchestrator errors this wave (both mine, both now rules in orchestrate-skill.md)

- **Claimed a defect that did not exist.** Reported the depth limit as broken based on an
  **introspection** probe — `graphql-depth-limit` does not count introspection queries, so the
  probe could not have shown a defect either way. A valid test proved the limit works. Also
  misstated the symptom: the guarded-query failure is HTTP **200** carrying
  `INTERNAL_SERVER_ERROR` in `errors[]` (Apollo returns 200 for resolver errors), not a bare 500.
- **Destroyed verified agent work.** `git checkout -- src/graphql/graphql.module.ts` to back out
  a temporary probe restores from **HEAD**, which predated the uncommitted changes — wiping the
  whole depth-limit wiring. Cost **62k** to re-apply. Back up with `cp` first.

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

### Wave 8 decisions (orchestrator, 2026-09-14) — the closing wave

**Deliberately built with ZERO agents.** Wave 8 is the one wave whose work is deterministic and
whose scope was already fully pinned by frozen contracts: two endpoints, one hook, three spec
files and an e2e suite. Waves 5–7 cost 292k / 353k / 339k; this wave cost nothing beyond the
orchestrator's own context. The rule this establishes (now in `orchestrate-skill.md` §6a): when
the remaining work needs no exploration — only writing against interfaces that already exist —
dispatch no agent at all.

Delivered (plan.md §11 Phases 12 + 13):

- **`GET /auth/me`** (+ GraphQL `me`) — the caller's identity with roles/permissions resolved
  through `IAuthorizationProvider.getContext()`, NOT read off `user.roles`. That distinction is
  the whole point: under `db-live` the session carries no claims, so a claim-reading `/auth/me`
  would answer "no permissions" for every user.
- **`POST /authz/check`** (+ GraphQL `checkPermission`) — `{ action, subject }` → `{ allowed }`.
  Guarded by `AuthGuard` + `RbacGuard` but with **no `@Permissions()`**: the endpoint asks about
  the caller's own grants and performs no privileged action, so gating it on a permission would
  be circular. The answer comes from the same `can()` `RbacGuard` uses.
- **New `AuthzService`** (`modules/auth/authz.service.ts`) owns both — deliberately not added to
  `AuthService`, whose Wave 5 surface was already frozen and needed no change.
- **`usePermission(action, subject)`** in `../client/src/lib/use-permission.ts`, plus
  `authApi.me()` / `authzApi.check()` in `client/src/lib/api.ts`.
- **e2e suite** `test/auth.e2e-spec.ts` — **the same spec file runs twice, once per
  `AUTH_STRATEGY`**, which is Phase 13's actual requirement.

**Decision — the frontend does NOT vendor `rbac-core.can()`.** Phase 12 says "publish/export
rbac-core for frontend consumption". The client is a separate repo with no package link, and a
browser-side copy of the policy would be a second source of truth that silently drifts from the
server's. So `usePermission()` is **server-authoritative**: it calls `/authz/check` and fails
closed (false while pending, false on error). Hiding a button is a UI affordance; the guard is
what denies. This also means no vestigial `frontend.ts` re-export exists — STYLE.md says delete
what nothing uses, and nothing would use it. If a future consumer genuinely needs the pure
functions in a browser, the fix is a workspace link to `src/rbac-core/`, not a copy.

**Decision — S1 fixed (was High severity).** `SessionRedisAuthStrategy.logout` now resolves its
own session id from either shape the frozen `logout(userId, sessionRef: unknown)` permits: the
opaque id, or the platform request it rides on. The auth controller passes the raw request and
must not name a strategy-specific cookie, so the strategy reads its own — exactly the placement
Wave 5's checkpoint prescribed. Contained entirely inside the `session-redis/` folder, so the
deletable-folder property holds. Regression-tested directly.

**e2e design constraints (why the harness looks the way it does):**

- **No live Postgres or Redis exists in this environment**, so the suite overrides only the
  persistence boundary (`USER_REPOSITORY`, `ROLE_REPOSITORY`, `PERMISSION_REPOSITORY`,
  `REFRESH_TOKEN_REPOSITORY`) with in-memory fakes in `test/support/`. Everything above it —
  guards, strategies, DTO validation, interceptors, exception filter, routing — is the real
  thing, which is what makes the interchangeability claim mean anything.
- **The strategy is swapped via a `Proxy` over the real `AppConfig`**, not by mutating
  `process.env`: `ConfigModule.forRoot()` validates env once, when `app.module.ts` is first
  imported, so a second `process.env` change would be ignored. Overriding just the
  `AUTH_STRATEGY` getter is the minimal seam that re-runs the strategy factory.
- **`ThrottlerStorage` is replaced with a reset-able in-memory store.** Otherwise the real
  ceilings (register 3/60s) make the suite assert 429s instead of the behaviour it means to
  check. The guard, the `@Throttle()` metadata and its arithmetic all stay in play, and the
  ceiling is asserted deliberately in its own describe block.
- **`LoginAttemptService` is overridden via the `protected createClient()` seam its own doc
  comment names for specs** — it builds its own Redis client, so without this the suite dials
  127.0.0.1:6379.
- **`main.ts`'s global pipe/interceptors/filter are re-applied in the spec.** Without them the
  suite would test a surface no client talks to. This is duplicated setup — see open items.

**Discoveries this wave:**

- **`test/app.e2e-spec.ts` was unrunnable and has been DELETED.** It was the Nest generator
  stub: it booted `AppModule` with `createNestApplication()` — the **default Express adapter** —
  so the Apollo driver called `loadPackage('@as-integrations/express5')` and killed the process
  (`process.exit(1)`) before a single assertion ran. It could never have passed in a
  Fastify-only app. It also only asserted the generator's own `Hello World!`. The real suite
  supersedes it. This was latent, not a Wave 8 regression.
- **S13 is real, reproduces on a live server, and the recorded hypothesis was WRONG.**
  `WAVE-LOG.md` guessed "the DTO is registered as an object type rather than an input type".
  It is not: the generated `src/schema.gql` correctly declares `input LoginDto` and
  `login(input: LoginDto!)`. The actual behaviour, measured against `node dist/main.js`:
  `query` reaches Apollo, **`variables` never does** — `{"query":"query($a: String!) {
  __typename }","variables":{"a":"x"}}` and the same body with **no `variables` key at all**
  produce the byte-identical error `Variable "$a" of required type "String!" was not provided.`
  Validation itself runs (a genuinely unused variable is rejected as "never used"), so this is
  the request body, not the schema. Corrected in `WAVE-LOG.md`; still open.
- **`@nestjs/throttler` does not re-export `ThrottlerStorageRecord`** from its entry point
  (it is in `throttler-storage-record.interface`, not `index.d.ts`). The test double restates
  the shape; `ThrottlerStorage` is structural so this satisfies it.

### Checkpoint — end of Wave 8 (2026-09-14) — ALL 8 WAVES COMPLETE

Gate, run by the orchestrator after every Wave 8 change:

- `pnpm build` → exit **0**
- `pnpm test` → exit **0**, **17 files / 142 tests passed** (was 13/94 at Wave 7)
- `pnpm test:e2e` → exit **0**, **1 file / 42 tests passed** (was: no working e2e at all)
- `pnpm exec tsc --noEmit -p tsconfig.json` → exit **0**
- `pnpm exec oxlint src/ test/` → exit **0**
- `node dist/main.js` → boots, "Nest application successfully started"
- **Live HTTP probes against the running server** (not just a boot):
  `GET /auth/me` → **401** and `POST /authz/check` → **401** for an unauthenticated caller,
  both with the standard error envelope; routes mapped (`Mapped {/auth/me, GET}`,
  `Mapped {/authz/check, POST}`).

The plan's 13 phases are all delivered. **No wave remains to dispatch.**

Open items / risks (Wave 8 additions first):

- **The e2e harness re-implements `main.ts`'s global setup** (pipe, three interceptors, filter).
  `main.ts` is not factored for reuse, so the two can drift: a new global enhancer added in
  `main.ts` would NOT be covered by the e2e suite until the spec is updated too. Fixing it means
  extracting `configureApp(app)` from `main.ts` and calling it from both — worth doing before
  the suite is relied on as a regression gate.
- **CSRF is not covered by e2e.** `main.ts` registers `@fastify/csrf-protection` only under
  `session-redis`, and the harness replicates `main.ts`'s global setup by hand — so the CSRF
  registration is the one piece deliberately not reproduced. The `session-redis` e2e run
  therefore does not exercise the CSRF path.
- **S2 still open (High if `session-redis` ships): the session cookie is never attached.**
  `createSessionCookieOptions()` exists and is the documented single source of truth, but no
  caller has a response handle at the point it holds the id. Fixing it is a contract decision
  (how a strategy delivers a response artifact), not a controller patch.
- **S13 still open**, now precisely characterized (above). Next step is a temporary probe that
  logs the body as Apollo receives it — and per `orchestrate-skill.md` §9b, `cp` the file to a
  scratch path first, never `git checkout --`.
- **`refresh()` recomputes the device meta but does not persist it.** `SessionRedisAuthStrategy`
  returns `refreshDeviceAndExpiry(record, meta)` while only the Redis TTL moves, so the stored
  blob keeps the login-time device and `validateRequest` reports where the session was created.
  Not security-relevant; pinned by a test so the behaviour is intentional rather than accidental.
- **The client is bearer-only.** `api.ts` never sets `credentials: 'include'`, so the Next.js
  client cannot use the `session-redis` cookie transport at all. Fine under the default pairing;
  a real limitation under option B.
- Carried forward, unchanged: Prisma migration path (`src/database/migrations/` is not
  auto-discovered by `prisma migrate`); `DB_PROVIDER=mongoose` reuses `DATABASE_URL` as the Mongo
  URI; Mongoose ObjectIds vs UUID strings; `db-live`/`session-redis` live paths still untested
  against a real Redis; S9 (`deletePermission` no `invalidate()` fan-out); S10 (Mongoose
  normalizes email in-adapter, the other three do not); S11 (seed `findOrCreatePermission` never
  updates existing rows); S12 (`autoSchemaFile` needs a writable `src/` in production); S14/S15
  (GraphQL throttle headers; lockout timing).

**Durable on disk:** the whole Wave 8 checkpoint (code + these plan docs) is committed at
`028cd00` — *"chore: auth+rbac bootstrap checkpoint — waves 1-8 complete"*. The companion client
is committed separately in `../client/` at `57ff6da`. Working trees are clean in both.

### Port playbooks added (2026-09-14)

Two agent-facing port skills were written, verified against HEAD rather than assumed:

- **`PORT-EXPRESS.md`** — stays on NestJS, swaps the HTTP adapter + the three `@fastify/*`
  plugins. Small, surgical. Records the empirically-proven blocker (the Apollo driver
  `loadPackage`s `@as-integrations/express5` and hard-exits when it is absent — the exact failure
  the deleted scaffold e2e produced), the `.code()` → `.status()` fix, the inverted
  `app.enableCors()` trap, and the `trust proxy` / `req.ip` correctness issue that silently
  collapses the per-IP throttler into one bucket.
- **`PORT-FRAMEWORK.md`** — leaving NestJS for Hono / Next.js / Elysia / bare Express. Built
  around the three-layer split the codebase's own design already produced: **invariant core**
  (`rbac-core` + repositories + the 4 strategy classes — all verified to carry *zero* Nest
  decorators), **wiring + port tax**, and **HTTP shell**.

Facts established while writing them (all grep-verified, none assumed):

- `src/rbac-core/` and `src/database/repositories/` contain **zero** `@nestjs` imports.
- All four strategy classes have **zero** `@Injectable`/`@Inject`/`@Module` decorators — they are
  already plain classes, constructible outside any DI container. This is what makes a port
  tractable and is worth protecting.
- The real port tax is **~52 HTTP-exception throw sites inside domain code**
  (27 `Unauthorized`, 8 `NotFound`, 8 `Conflict`, 7 `Forbidden`, 2 `InternalServerError`) plus
  `@nestjs/jwt` (used only for `sign`/`verify`/`decode`), `Logger` (13 sites) and
  `@nestjs/config`. `PORT-FRAMEWORK.md` §3 gives two resolutions and recommends the cheap one
  (a domain-error shim) for a first port.
- `@Module()` appears in **9** files; `FastifyRequest`/`FastifyReply` in **9** source files.
  (Both counts were wrong on first draft and corrected before commit — the §9 discipline of
  checking the artifact, not the impression.)
- `pnpm test:e2e`'s 42 assertions are the port's oracle: they speak only HTTP and the
  `{ data, meta }` envelope, so a port rewrites the harness and leaves every assertion
  byte-identical. A failing assertion is then a port defect, not a test to adjust.

Neither playbook changes any code. They are documentation only.

### TEST-PLAN.md added (2026-09-14)

A build plan for the test suite, written for a fresh orchestrator chat: `.agents/plan/TEST-PLAN.md`.
Named `TEST-PLAN.md`, **not** `plan.md`, because the architecture plan already owns that name.

It is grounded in verified gaps, not a generic checklist. Before writing it I checked each
suspicion, and two were wrong — recorded here so nobody repeats the check:

- **The JWT security spine IS well tested.** `jwt-stateless.auth-strategy.spec.ts` already covers
  `RefreshTokenService` (hash-only persistence, rotation within a family, replay → whole-family
  revocation, unknown/expired) and JWT pinning (RS256 keypair, **HS256 forged with the public key
  as the HMAC secret** — the classic algorithm-confusion attack — and wrong issuer/audience). An
  earlier draft of the plan was about to claim this was untested. It is not.
- **Email case-normalization is service-boundary, so a naive contract test would mislead** — see
  S10, which the contract suite is designed to force to a decision.

The gaps that are real, each confirmed by inspection at HEAD:

| Gap | Evidence |
|---|---|
| `src/database/` has **zero** tests | `find src/database -name "*.spec.ts" \| wc -l` → `0`. 16 repository implementations across 4 ORMs, never executed by any test — the e2e substitutes them with in-memory fakes |
| GraphQL is **never** exercised by e2e | `grep -c "graphql" test/auth.e2e-spec.ts` → `0`. It would have caught **S13** |
| Coverage is measured by nothing | `@vitest/coverage-v8` + a `test:cov` script exist, but no `coverage` block, no thresholds, not in the gate |
| The e2e harness duplicates `main.ts` and drifts | `MEMORY.md` records it; the `session-redis` CSRF registration is silently uncovered |
| Untested units on the security path | `session-cookie.ts` (hand-rolled parser), `authz-context-cache.ts` (key collision = cross-user leak), `token.service.ts`, `transform.interceptor.ts` (client-visible envelope), `timeout.interceptor.ts`, the decorators, the DTOs, the seed |

The plan's central proposal is a **repository contract suite** — one shared behavioural contract
file run against all four ORM adapters, the same "one spec file, N providers" trick Phase 13 used
for the auth strategies. It is the only practical way to test 16 adapter files, and it forces
S10 and S11 to a decision instead of leaving them as notes.

**TEST-PLAN.md revised same day — granularity fix.** The first draft specified Wave 1 as **four
agents, one per ORM adapter**. That was wrong and was corrected to **four agents *in total*, one
per section** (`db-contract`, `graphql-e2e`, `integration`, `unit-gap`), dispatched in parallel.
It contradicted `orchestrate-skill.md` §1's own measured finding — cost scales with scope, not
layer count, and splitting one task across N agents does not divide its cost because each agent
re-pays the orientation tax. The four adapters share one contract file, so the shared-boundary
work (the contract itself, plus both vitest configs and all `package.json` scripts) is done by
the orchestrator in Wave 0; that is precisely what makes the four-way parallel safe.

Two other additions from the same pass: §0 states plainly that the file is a *specification an
orchestrator executes*, not something that spawns agents itself (the only harness requirement is
the ability to spawn subagents concurrently), and §5 now carries **copy-paste dispatch prompts**
for each of the four sections, so the orchestrator's dispatching is mechanical rather than
improvised.

### orchestrate-skill.md revised — §2 is now the dispatch decision (2026-09-14)

The skill previously buried its most important rule in §2 ("one agent per genuinely independent
deliverable") — abstract enough that the TEST-PLAN first draft ignored it and proposed four
agents for four ORM adapters that share one contract test. Rewritten so the decision is
unmissable and mechanical. **No section was renumbered**, so every existing cross-reference in
`TEST-PLAN.md`, `PORT-*.md`, `WAVE-LOG.md` and `README.md` still resolves; the only edits to
other files were three pointers that had drifted (`§2` → `§1`/`§2b`).

What §2 now says:

- **2a — the dispatch decision**, four ordered questions. First "yes" wins: can I name every file
  I will edit right now → *do it inline, dispatch nobody*; will two workstreams edit the same
  file → *that file is orchestrator Wave 0*; under ~10 lines and no exploration → *orchestrator*;
  otherwise → *one agent per section*.
- **2b — sizing and the concurrency ceiling**: 40–120k per agent; past ~150k it has left its
  section (re-scope the *deliverable*, never subdivide into more agents); 4–5 concurrent agents
  is the practical ceiling; parallelism does not reduce the wall-clock floor set by the longest
  section.
- **2c — what makes parallelism safe**: clear *every* shared boundary before dispatch —
  manifests, configs, lockfiles, test harnesses, interfaces, entry points. If you cannot, run it
  sequentially; a merge conflict between agents is neither cheap nor safe.

§1 gained the third conclusion that ties cost to quality: **hallucination is what you buy when
you under-pay the orientation tax** — an agent that cannot find an interface guesses it, and
guessed interfaces are the largest single source of rework in this project's history. The fix is
never a better agent; it is copying the frozen signature into the prompt and narrowing the read
list so there is nothing left to guess.

§13 now states the mentality as three dials in priority order: turn **total wave scope down**,
turn **per-agent scope up**, and raise **agent count** only as high as there are genuinely
independent sections. Plus the failure mode worth naming: a capable orchestrator does not fail by
laziness, it fails by dispatching reflexively — spawning an agent *feels* like progress while it
converts context you already hold into a hand-off seam.

Two anti-pattern rows added: "one agent per file / per implementation of one interface" and
"parallelizing without clearing shared files first".
