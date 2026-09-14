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

## Wave 7 — security hardening ✅ (2026-09-14)

Model: 2 concurrent verticals, then a **defect chain of 2 more fix agents**. **Total ≈ 339k.**
Unlike Wave 6, the extra spend was *not* scope — it was a cascade of latent defects that each
fix unmasked, all one root cause (see below).

| Agent | Task | Tokens | Tool calls | Duration |
|---|---|---|---|---|
| rate-limit-agent | `LoginAttemptService`, lockout wiring, `ThrottlerModule` + global guard | 74.7k | 53 | 228s |
| transport-hardening-agent | CORS, GraphQL depth/complexity limits | 54.8k | 44 | 171s |
| ↳ *same agent, resumed* | *re-apply depth-limit work destroyed by orchestrator* | *62.0k* | *12* | *46s* |
| gql-context-fix-agent | fix LoggingInterceptor + HttpExceptionFilter on GraphQL contexts | 59.5k | 49 | 243s |
| throttler-graphql-agent | make the global throttler GraphQL-aware | 88.3k | 70 | 301s |

**Gate (orchestrator, independently re-run):** build **0** · `pnpm test` **13 files / 94 passed**
(was 12/89) · `tsc --noEmit` **0** · `oxlint src/ test/` **0** · boots with and without
`CORS_ORIGINS`.

**End-to-end HTTP verification (orchestrator, real `dist/main.js` on :3000):**

| Probe | Result |
|---|---|
| guarded GraphQL `{ roles { id } }` | `Unauthorized` — reaches AuthGuard, no crash |
| `{ __typename }` | 200 |
| **GraphQL `login` mutation loop ×8** | **3 throttled — PASS, GraphQL is NOT a rate-limit bypass** |
| REST `POST /auth/login` loop ×8 | 3 × HTTP 429 |

**Dependencies resolved by orchestrator (pre-flight):** `@fastify/cors@11.3.0`,
`graphql-depth-limit@1.1.0`, `graphql-query-complexity@2.0.0`,
`@types/graphql-depth-limit@1.1.6` (dev).

### The defect chain — one root cause, three crashes

**Every global HTTP enhancer breaks on GraphQL**, because each calls `context.switchToHttp()`
unconditionally and gets `undefined` for a GraphQL context. Latent since Wave 1; only became
reachable when Wave 6 registered `GraphQLModule`. Each fix unmasked the next:

1. `LoggingInterceptor` — `request.method` on undefined (Wave 1 file)
2. `HttpExceptionFilter` — same, and it crashed *before* it could write a response, which is
   what **masked** #3
3. `ThrottlerGuard` (stock, `@nestjs/throttler@6.5.0`) — no GraphQL branch; `getTracker()` read
   `req.ip` on undefined. Fixed by subclassing and overriding only `getRequestResponse`
   (`src/common/guards/graphql-throttler.guard.ts`).

**Security-relevant detail:** the tempting fix for #3 — skip throttling for non-HTTP contexts —
would have been a **brute-force bypass**, because `login`/`register`/`refresh` are exposed as
GraphQL mutations. The agent was explicitly forbidden from taking that route and required to
prove a real throttle over GraphQL, which it did.

None of the three was visible to `build`, `test`, `tsc`, `oxlint`, a clean boot, or an
adversarial code-reading verifier. **Only executing a real resolver exposed them.**

### Orchestrator errors this wave (both mine)

- **Claimed a defect that did not exist.** Reported "depth limit not enforcing" from a probe
  using an introspection query — `graphql-depth-limit` does not count introspection queries, so
  the probe was incapable of showing a defect either way. The limit worked; a valid test proved
  it (`400 GRAPHQL_VALIDATION_FAILED` at a lowered ceiling). Symptom also misstated: the real
  guarded-query failure was HTTP **200** carrying an `INTERNAL_SERVER_ERROR` in `errors[]`, not
  a bare 500.
- **Destroyed verified agent work.** Used `git checkout -- src/graphql/graphql.module.ts` to
  back out a temporary probe; that restores from HEAD, which predated the uncommitted changes,
  wiping the entire depth-limit wiring. Cost **62k** to re-apply. Correct approach: `cp` the
  file to a scratch path first.

Both are now rules in `orchestrate-skill.md` (§9a, §9b).

### New defect found (not fixed — recorded)

- **GraphQL variables do not work.** A query declaring `$i: LoginDto!` and sending `variables`
  is rejected at validation: `Variable "$i" of required type "LoginDto!" was not provided` /
  the type is "not usable as an input type". Happens before guards, untouched by Wave 7, and
  forces clients to inline literals. Surfaced incidentally by the throttler agent. **Needs a
  dedicated look** — likely the DTO is registered as an object type rather than an input type,
  or the `@InputType()` name collides. Recorded as **S13**.

---

## Current project status (as of Wave 7, HEAD to be set by the Wave 7 commit)

Waves 1–6 of 8 complete. Gate: build 0 · test **10 files / 77 passed** · `tsc --noEmit` 0 ·
oxlint 0 · boot verified.

### Open security items (for the validation pass)

| # | Item | Severity | Status |
|---|---|---|---|
| S1 | `logout` no-ops under `session-redis` — session never invalidated | High (if session-redis shipped) | **OPEN** |
| S2 | Session cookie never attached under `session-redis` — cookie-only refresh impossible | High (if session-redis shipped) | **OPEN** |
| S3 | Baseline permission deletion (F1) | High | FIXED + mutation-verified |
| S4 | `auth.guard.spec.ts` absent — `@Public()` bypass, `req.user = user` untested | Medium | OPEN (Wave 8) |
| S5 | Brute-force lockout + throttler unwired (spec §6) | High | **FIXED in Wave 7** — verified by real throttling over both transports |
| S6 | GraphQL depth/complexity limiting absent (plan line 359) | Medium | **FIXED in Wave 7** — verified enforcing end-to-end |
| S7 | `@nestjs/throttler@6.5.0` peers stop at Nest `^11` | — | **RESOLVED — stale metadata.** Empirically boots and throttles on Nest 12 |
| S8 | `rbac-core.hasRole`/`hasAnyPermission` lack the null-guard `can()` has | Low | Accepted (only `can()` gates) |
| S9 | `deletePermission` does not fan out `invalidate()` | Low | OPEN (needs another contract method) |
| S10 | Mongoose normalizes email in-adapter; the other 3 do not (spec §9 "identical") | Low | OPEN, pre-existing |
| S11 | Seed `findOrCreatePermission` never updates — old rows keep `is_system = false` | Low | OPEN (no contract method to backfill) |
| S12 | `autoSchemaFile` requires a writable `src/` in production | Low | OPEN |
| **S13** | **GraphQL variables do not work** — `$i: LoginDto!` + `variables` rejected at validation ("not usable as an input type"); clients must inline literals | **Medium-High (API usability)** | **OPEN — found in Wave 7, not fixed** |
| **S14** | GraphQL rate-limit responses lack `X-RateLimit-*`/`Retry-After` headers (the Apollo context never receives the Fastify `reply`); limits are identical, headers advisory-only. GraphQL also returns HTTP 200 for throttle errors (Apollo maps 429 → `INTERNAL_SERVER_ERROR`, driver resets status) | Low | Documented, by design for now |
| **S15** | Lockout timing: spec §6 mandates the cheap `isLocked()` check *before* password verification, so a locked account answers **faster** than a wrong password — timing can reveal lockout state for a known address | Low | Accepted per spec; deliberate, not an oversight |

### Deferred / not yet built

- **Wave 8** — `frontend-kit-agent` ∥ `test-agent`: unit + e2e, `/auth/me` + `/authz/check`,
  React `usePermission()`.

### Wave 7 delivered (for the validation pass to check against plan §11 Phase 11)

- **CORS** — deny-all by default; activates only when `CORS_ORIGINS` (optional, comma-separated)
  is set. `credentials: true` only under `session-redis` (ambient cookie), off under
  `jwt-stateless`. Registered via `@fastify/cors` directly, not `app.enableCors()` — the latter
  typechecks but would crash at boot (`skipLibCheck` hides the unresolvable import).
- **Throttling** — `ThrottlerModule` floor (ttl 60s / limit 100) + global `GraphqlThrottlerGuard`;
  per-route `@Throttle()` ceilings on the auth routes (register 3, login 5, refresh 5 per 60s)
  continue to override the floor, on **both** transports.
- **Lockout** — `LoginAttemptService` (spec §6: 15-min window, lock at 10). Degrades safely:
  `REDIS_URL` unset (the default pairing) ⇒ no-op plus one boot warning, never throws. Fails
  *open* on Redis errors, so an unreachable Redis cannot lock everyone out. Same
  `INVALID_CREDENTIALS` message as every other login failure, including lockout.
- **GraphQL limits** — `depthLimit(10)` + complexity `1000`, via the Apollo driver's
  `validationRules`; verified enforcing with a real query.
- Already done in Wave 1 and left alone: helmet, and CSRF (conditional on `session-redis`,
  spec §7).

### Carried from Wave 4 (still open)

Prisma migration path (now two migrations); `DB_PROVIDER=mongoose` reuses `DATABASE_URL`;
Mongoose ObjectIds vs UUID strings; Redis/Postgres live paths untested.

---

## Wave 8 — frontend kit + tests ✅ (2026-09-14) — CLOSING WAVE

Model: **no agents at all.** The orchestrator built this wave inline. Every interface it needed
was already frozen, so there was nothing to explore and nothing to parallelize; dispensing with
agents removed the per-agent orientation tax entirely (Waves 5–7 spent 292k / 353k / 339k).

| Agent | Task | Tokens |
|---|---|---|
| — | *(none dispatched)* | 0 |

**Gate (orchestrator):** build **0** · `pnpm test` **17 files / 142 passed** (was 13/94) ·
`pnpm test:e2e` **1 file / 42 passed** (was: no runnable e2e) · `tsc --noEmit` **0** ·
`oxlint src/ test/` **0** · boots · live probes: `GET /auth/me` → 401 and
`POST /authz/check` → 401 unauthenticated, both routes mapped.

**Delivered (plan.md §11 Phases 12 + 13):**

- `GET /auth/me` + GraphQL `me` — identity with roles/permissions resolved through
  `IAuthorizationProvider.getContext()` (a claim-reading version would return nothing under
  `db-live`).
- `POST /authz/check` + GraphQL `checkPermission` — `{action, subject}` → `{allowed}`, from the
  same `can()` `RbacGuard` uses. Guarded, but deliberately **no `@Permissions()`** (asking about
  your own grants is not a privileged action).
- `AuthzService` owning both; `AuthService`'s frozen Wave 5 surface untouched.
- Client: `usePermission(action, subject)` + `authApi.me()` / `authzApi.check()`.
- `test/auth.e2e-spec.ts` — **one spec file, run twice, once per `AUTH_STRATEGY`** (Phase 13's
  requirement). Real `AppModule`; only the persistence boundary is replaced (in-memory repos in
  `test/support/`), because no live Postgres or Redis exists here.

**Defects found and fixed:**

- **S1 (High) FIXED.** `SessionRedisAuthStrategy.logout` resolves its own session id from either
  shape the frozen `logout(userId, sessionRef: unknown)` permits — the opaque id, or the platform
  request the controller passes. Placed in the strategy, per Wave 5's prescription; contained in
  the `session-redis/` folder so the deletable-folder property holds. Regression-tested.
- **`test/app.e2e-spec.ts` DELETED — it was unrunnable.** The Nest generator stub booted
  `AppModule` with `createNestApplication()` (the default **Express** adapter), so the Apollo
  driver called `loadPackage('@as-integrations/express5')` and killed the process with
  `process.exit(1)` before any assertion ran. It could never have passed in a Fastify-only app,
  and it only asserted the generator's own `Hello World!`.

**Finding corrected — the recorded S13 hypothesis was wrong:**

WAVE-LOG previously guessed the cause was "the DTO is registered as an object type rather than an
input type". It is not: `src/schema.gql` correctly declares `input LoginDto` and
`login(input: LoginDto!)`. Measured against a live `node dist/main.js`:

| Probe | Result |
|---|---|
| `query($a: String!){__typename}` **with** `variables:{"a":"x"}` | `Variable "$a" of required type "String!" was not provided` |
| The **identical query with no `variables` key at all** | **byte-identical error** |
| Declaring a variable and never using it | `Variable "$a" is never used` — validation *does* run |

So `query` reaches Apollo and **`variables` never does**; the schema is not implicated. S13 is
still **OPEN** but now precisely characterized. Cheapest next step: a temporary probe that logs
the body as Apollo receives it — `cp` the file to a scratch path first (`orchestrate-skill.md`
§9b), never `git checkout --`.

**Incidental:** `@nestjs/throttler` does not re-export `ThrottlerStorageRecord` from its entry
point (`index.d.ts` omits it); the test double restates the shape, which satisfies the structural
`ThrottlerStorage` interface. `pnpm test:e2e` did not previously run anything meaningful — its
only file was the unrunnable stub above.

**New open items:** the e2e harness re-implements `main.ts`'s global setup by hand (pipe, three
interceptors, filter) and omits the `session-redis` CSRF registration, so those two can drift
from `main.ts`; the fix is to extract a shared `configureApp(app)`. `refresh()` recomputes the
device meta without persisting it (pinned by a test, not security-relevant). The client is
bearer-only — `api.ts` never sets `credentials: 'include'`, so it cannot use cookie sessions.

---

### Amendment (2026-09-14, end of Wave 8) — status of the open security items

Supersedes the "Current project status (as of Wave 7)" and open-items table above; the Wave 1–7
entries themselves are unchanged history.

**Waves 1–8 of 8 complete.** All 13 phases of `plan.md` §11 are delivered. Gate as recorded
under Wave 8. **No wave remains to dispatch.**

| # | Item | Severity | Status |
|---|---|---|---|
| S1 | `logout` no-ops under `session-redis` | High (if session-redis ships) | **FIXED in Wave 8** — strategy reads its own session ref; regression-tested |
| S2 | Session cookie never attached under `session-redis` | High (if session-redis ships) | **OPEN** — needs a contract decision (how a strategy delivers a response artifact) |
| S3 | Baseline permission deletion (F1) | High | FIXED + mutation-verified (Wave 6) |
| S4 | `auth.guard.spec.ts` absent — `@Public()` bypass, `req.user` untested | Medium | **FIXED in Wave 8** — new spec covers the bypass, the 401 path, the `req.user` assignment, and both transports |
| S5 | Brute-force lockout + throttler unwired | High | FIXED in Wave 7 |
| S6 | GraphQL depth/complexity limiting absent | Medium | FIXED in Wave 7 |
| S7 | `@nestjs/throttler` peers stop at Nest `^11` | — | RESOLVED — stale metadata |
| S8 | `rbac-core.hasRole`/`hasAnyPermission` lack `can()`'s null-guard | Low | Accepted |
| S9 | `deletePermission` does not fan out `invalidate()` | Low | OPEN |
| S10 | Mongoose normalizes email in-adapter; the other 3 do not | Low | OPEN, pre-existing |
| S11 | Seed `findOrCreatePermission` never updates existing rows | Low | OPEN |
| S12 | `autoSchemaFile` requires a writable `src/` in production | Low | OPEN |
| **S13** | **GraphQL `variables` never reach Apollo on POST** — clients must inline literals | Medium-High | **OPEN — root cause re-characterized in Wave 8 (see above); the schema is NOT the cause** |
| S14 | GraphQL rate-limit responses lack `X-RateLimit-*`/`Retry-After` | Low | Documented, by design |
| S15 | Lockout timing: a locked account answers faster than a wrong password | Low | Accepted per spec |

### Per-agent token cost, complete series

| Wave | Agents | Total |
|---|---|---|
| 1–4 | see above | not recorded (earlier session) |
| 5 | 4 build + 1 verifier | ≈ 292k |
| 6 | 2 build + 1 verifier + 1 fix | ≈ 353k |
| 7 | 2 build + 2 fix | ≈ 339k |
| 8 | **none — built inline** | **0** |

---

## Wave 9 — build the test suite per `TEST-PLAN.md` ✅ (2026-09-14)

Executed `TEST-PLAN.md` end-to-end. **One orchestrator-only Wave 0, then four section agents
dispatched simultaneously** (A: DB contract, B: GraphQL e2e, C: integration, D: unit gaps),
then one diff-scoped adversarial verifier. The plan's granularity rule held: one agent per
*section*, never per file — and no two agents shared a file.

### Baseline, re-measured (not taken from the plan)

```
pnpm test      → 17 files / 142 tests
pnpm test:e2e  →  1 file  /  42 tests
```
Both matched `TEST-PLAN.md` §1 exactly, so its gap analysis was trustworthy.

### Gate at HEAD (all green, verbatim)

```
pnpm build                              0
pnpm test                               29 files / 256 passed
pnpm test:contract                       4 files / 108 passed
pnpm test:integration                    6 files /  46 passed  (+2 expected fail)
pnpm test:e2e                            2 files /  82 passed  (+2 expected fail)
pnpm test:smoke                          16/16 checks, exit 0
pnpm exec tsc --noEmit -p tsconfig.json  0
pnpm exec oxlint src/ test/              0
node dist/main.js                        boots; POST /auth/register → 201, GET /auth/me → 401
```

Unit count **142 → 256**. e2e **42 → 84 assertions** (the original 42 byte-identical, verified
by diffing assertion lines against `git show HEAD:test/auth.e2e-spec.ts` — 40 `expect(` and
21 `it(` before and after, unchanged; only machinery moved into the harness).

### Wave 0 (orchestrator only — the shared boundaries, cleared before dispatch)

| # | Delivered | Why it had to precede the agents |
|---|---|---|
| 1 | `src/configure-app.ts` — `configureApp(app)`; called by `main.ts` **and** the e2e harness | Two consumers, one file. Closes §3.5: a new global enhancer is now covered by e2e automatically, and the `session-redis` CSRF registration is under test for the first time |
| 2 | `test/support/harness.ts` (`createTestApp`, `authorize`, `STRATEGIES`, `uniqueEmail`); `test/support/e2e-setup.ts` (the ioredis stand-in, via the e2e config's `setupFiles`) | Agents B and C both import it and must not edit it |
| 3 | `docker-compose.test.yml` — Postgres 55432, Redis 56379, **Mongo 57017**; `test:services:up/down` | Shared infrastructure. **The plan's spec omitted Mongo** — see correction 1 below |
| 4 | `vitest.config.contract.ts`, `vitest.config.integration.ts`, all `package.json` scripts | Otherwise A and C both edit `package.json` and both create a config — a guaranteed write race |
| 5 | `vitest.coverage.ts` + ratcheted per-directory thresholds | One place to ratchet; mutation-checked (see below) |
| 6 | `test/smoke/boot.smoke.ts` + `tsconfig.smoke.json` (orchestrator, unowned by any agent) | The gate's boot + real-request step (§4 kind 6) |

### Three corrections to `TEST-PLAN.md`, all verified in source before dispatch

1. **The plan's Docker spec was incomplete.** It lists Postgres + Redis only, but
   `DB_PROVIDER=mongoose` dials `createMongooseClient(uri)` — a `mongodb://` URL. A contract
   suite that cannot run one of its four providers is not a contract suite. Mongo added on
   **57017**, and `MONGO_URL` is exported to the contract config.
2. **§7.2 assumes a lockout env override that does not exist.** `LoginAttemptService` hardcodes
   `LOCK_THRESHOLD = 10` and `WINDOW_SECONDS = 15 * 60` as module constants; there is no
   test-only override. Agent C was told to assert the expiry is *armed* (Redis `TTL` ∈ (0, 900]
   after the 10th failure — a real assertion that fails if `expire` was never called) rather
   than wait out a 15-minute window. Recorded as an open item below.
3. **`tsx` cannot boot this app.** esbuild — used by both `tsx` and vitest — emits no
   `design:paramtypes` metadata under `tsx`, so Nest cannot resolve constructor injection and
   the process dies on `LoginAttemptService` reading `REDIS_URL` off `undefined`. Measured
   directly: `Reflect.getMetadata('design:paramtypes', LoginAttemptService)` is `undefined`
   under `tsx` and `[Function AppConfig]` under vitest. The seed survives only because it
   injects `AppConfig` through an explicit factory provider. **`test:smoke` therefore compiles
   via `tsconfig.smoke.json` into `.smoke-dist/` and runs under `node`** — scratch dir, so it
   never races `pnpm build` on `dist/` while agents run concurrently.

### The coverage blind spot was worse than reported (§3.3)

The existing config had **no `coverage.include`**, so vitest reported only files some test
happened to import. It read **91% statements** while `src/database/**` — 16 repository
implementations across four ORMs — sat at **0% and was simply absent from the table**. With
`include: ['src/**/*.ts']` the honest number is **40%**. Coverage is now a gap-finder: the
whole of `src/` is reported, and thresholds are set **only** on the five security-critical
directories (§6), as floors measured at this baseline and rounded down.

**Mutation-checked:** raising the `src/rbac-core/**` threshold to 101 makes `test:cov` emit
`ERROR: Coverage for … does not meet "src/rbac-core/**" threshold (101%)` for all four metrics.
The gate is load-bearing, not decorative.

### Verified independently by the orchestrator (not taken from agent reports)

- **The REST suite is unmodified.** 40 `expect(` / 21 `it(` before and after; the diff removes
  only machinery that moved into `harness.ts`. DoD requires this and it holds.
- **Soft-delete is load-bearing on real code.** Deleting `deletedAt: null` from the *production*
  `prisma-user.repository.ts#findByEmail` fails exactly one contract test and nothing else
  (107 passed), then passes again on restore. (Agent A mutated the test helper instead; this
  mutates the adapter, which is the stronger check.)
- **The boot smoke can actually fail.** Removing the `{ data, meta }` envelope from
  `transform.interceptor.ts` fails 7 of its 16 checks and exits 1. The first version of the
  smoke could *not* fail — see the orchestrator-error note below.
- **The contract suite was not weakened per provider.** The shared contract has no
  provider-conditional branches; the four specs are 4 lines each.
- **S13's quarantine is honest.** `it.fails`, written against the *intended* behaviour
  (`errors` undefined, `data.login.user.email` present), with a comment naming S13 and warning
  against pinning the broken behaviour as correct.

### New defects and divergences the suite exposed

| # | Finding | Severity | Disposition |
|---|---|---|---|
| **N1** | **`DB_PROVIDER=drizzle` cannot insert against the migrated schema.** `drizzle/schema.ts` declares `.defaultRandom()` on ids and `.defaultNow()` on `updated_at` and inserts `DEFAULT`; the migrations declare neither (Prisma fills both client-side). Every Drizzle insert died on `null value in column "id" violates not-null constraint` — 22 of 27 tests | **High** — an advertised headline feature is broken | **OPEN.** Agent A's harness reconciles the schema (`alignSchemaWithAdapters`) so the adapter is *exercised*, which means Drizzle currently passes the contract against a schema production does not have. Fix is either defaults in a migration or removing them from the drizzle schema — a `src/` change, out of scope for a test wave |
| **N2** | **Timestamp type drift.** Migrations declare `TIMESTAMP(3)` (no zone); `drizzle/schema.ts` declares `withTimezone: true` and Sequelize maps `DataTypes.DATE` → `timestamptz`. node-pg parses a zoneless timestamp as **local** time, so on this non-UTC host Sequelize returned `expiresAt` shifted by the IST offset and Prisma did not | **Medium** — silent, host-dependent data corruption | **OPEN**, recorded |
| **N3** | **S10 is now measured, not a note.** Mongoose normalizes email on write *and* lookup; the other three match byte-for-byte (table in the agent report, reproduced below) | Low (masked in practice — the app lowercases at the boundary) | **CLOSED as a written exception** in `CONTRACTS.md` §5, with the measured table. Not fixed: it would change three adapters' write paths |
| **N4** | **`refresh` does not fail closed on a Redis outage.** `validateRequest` catches; `refresh` does not, so an outage on the token-refresh path reaches the exception filter as a raw ioredis error (~500) instead of the clean 401 the guard path produces | Medium | **OPEN** — pinned by a test |
| **N5** | **A soft-deleted account permanently reserves its email.** `users_email_key` is unconditional, so the address is still held; `assertEmailIsAvailable` uses `findByEmail` (which filters `deletedAt`), so re-registration reaches the raw unique violation as a Prisma error instead of a `ConflictException` | Medium | **OPEN** — pinned by a test |
| **N6** | **Deactivating an account does not revoke its live session.** `validateRequest` returns the Redis snapshot unchanged — the blob still says `isActive: true`. Quarantined with `it.fails` | Medium | **OPEN** — quarantined, pending verifier |
| **N7** | **The classic alg-confusion test was not load-bearing for the `algorithms` pin.** With `algorithms` removed from `verifyOptions()`, the HS256-forged-with-the-public-key test still passes — jsonwebtoken v9 rejects an HMAC token itself when the key material is a PEM key | Low-ish, but it means a security test was false comfort | **FIXED by agent D**: an HS384 token signed with the same symmetric secret is now asserted rejected, and *that* test fails when the pin is removed |
| **N8** | **`@prisma/client` was not generated at HEAD** — nothing Prisma-based could run at all. Agent A ran `prisma generate` (idempotent). Any agent using the Prisma adapter needs this done once | — | **RESOLVED** |

### Orchestrator errors this wave (both mine)

1. **The first smoke script could not fail.** It asserted route mapping with
   `printRoutes().includes('/auth/register')` — a human-formatted tree that does not contain
   those paths as literal substrings. It reported "unmapped" for routes that demonstrably
   answered requests, i.e. it measured its own parser, not the app (`orchestrate-skill.md` §9a,
   third instance in this project). Replaced with the router's own `hasRoute({ method, url })`.
2. **The first mutation-check of the smoke was vacuous.** I "broke" it by pointing
   `DATABASE_URL` at a dead port — but the script hardcodes its own DB URL and overwrites the
   env var, so the mutation changed nothing and the probe could not have detected it. Redone
   properly against the transform envelope, which does bite.

Also: my probe always sent `content-type: application/json` even with no body, which made
`POST /auth/logout` fail DTO validation with a 400 that had nothing to do with logout. Fixed —
and it is exactly the class of false alarm §9a warns about.

### Process note — the session was interrupted

The four section agents were stopped mid-flight by a session end. `git status` showed A's
shared contract + 5 factories with **no specs** (so `test:contract` matched zero files), B's
spec half-tuned, C's section absent entirely, D's first 4 specs landed. All four were **resumed
from their saved transcripts** rather than re-dispatched fresh — they kept their orientation
instead of re-paying the tax `orchestrate-skill.md` §1 measures. Everything above is the state
after that resumption.

### Token cost

| Agent | Section | Tokens (resumed session) |
|---|---|---|
| A `db-contract-agent` | `test/contract/**` | 98.9k |
| B `graphql-e2e-agent` | `test/graphql.e2e-spec.ts` | 95.7k |
| C `integration-agent` | `test/integration/**` | 134.3k |
| D `unit-gap-agent` | 12 new `*.spec.ts` | 105.3k |
| verifier (diff-scoped) | whole wave diff | see below |

Every section landed inside the plan's 40–100k target band or just over it (C at 134k, still
well under the ~150k re-scope trigger), and no agent had to be subdivided.

### Open items opened or changed by this wave

| Id | Item | Status |
|---|---|---|
| S2 | Session cookie never attached | **Still OPEN**, now *regression-tracked* — `it.fails` in `test/integration/session-cookie-s2.integration-spec.ts`, verified red before quarantine, flips green when a caller attaches the cookie |
| **S10** | Mongoose email normalization | **CLOSED** as a written exception in `CONTRACTS.md` §5 (measured table) |
| **S13** | GraphQL `variables` never reach Apollo | **Still OPEN**, now *regression-tracked* — `it.fails` (2, one per strategy) with the raw failure text recorded |
| **S16** | No test-only override for the lockout window; `LOCK_THRESHOLD`/`WINDOW_SECONDS` are hardcoded | NEW, Low — `TEST-PLAN.md` §7.2 assumes an override that does not exist |
| **S17** | `DB_PROVIDER=drizzle` cannot insert against the migrated schema (N1) | NEW, **High** |
| **S18** | Migration/ORM timestamp-type drift (N2) | NEW, Medium |
| **S19** | `refresh` does not fail closed on a Redis outage (N4) | NEW, Medium |
| **S20** | Soft-deleted account permanently reserves its email (N5) | NEW, Medium |
| **S21** | Deactivating an account does not revoke its live session (N6) | NEW, Medium |
| **S22** | `app.close()` does not release Prisma/Redis handles — nothing implements `onModuleDestroy`, so the process hangs open after the app is closed, and `main.ts`'s `enableShutdownHooks()` tears down with those connections still open | NEW, Low–Medium |

### Still open from `TEST-PLAN.md`'s own definition of done

- `MEMORY.md` updated with the new gate results and test files — **done**.
- `orchestrate-skill.md` §7 updated to include the new commands — **done**.
- `README.md` script table updated — **done**.
- Wave 2 adversarial verifier — dispatched; its findings are appended in the next section.

### Wave 2 verifier — findings and disposition

One diff-scoped adversarial verifier, 146k tokens, 60 tool calls. It did real work: it
reproduced S13 over a real socket (not supertest), proved the hash-at-rest assertion bites by
inserting `raw-token-PLAINTEXT-PROBE` in a rolled-back transaction and reading it back verbatim,
and independently re-confirmed S17/S18 against the unpatched `auth_integration` schema.

**Confirmed sound (no action):**
- **No mock-round-trip tests.** `grep -l "vi.fn|vi.mock|vi.spyOn"` over all 12 new unit specs,
  `test/integration/**` and `test/contract/**` returns nothing. Every collaborator is a
  hand-written fake and the assertions target the module under test.
- **Hash-at-rest is load-bearing.** `repository-contract.ts:351-353` reads physical storage via
  a separate raw `pg` client (`postgres-admin.ts:52-55`), not the repository's own report.
- **N6/S21 is a REAL defect, not a misunderstanding** — so agent C's ledger entry stands.
  `session-redis.auth-strategy.ts:68-79` returns `record.user` straight out of the Redis blob
  and never consults the account row; `jwt-stateless.auth-strategy.ts:72` by contrast re-reads
  the DB and throws on `!user.isActive`.
- **All four quarantines assert INTENDED behaviour.** None pins a bug as correct.

**Fixed as a result (all mutation-checked):**

| # | Finding | Fix |
|---|---|---|
| V1 | **VACUOUS** — `session-store.spec.ts:75` used `not.toContain(sessionId)`, which is trivially true because every key is `session:<hash>`; it could not catch `session:<raw id>`, the exact defect its comment named | Now `.some(key => key.includes(sessionId))`. Mutation: storing the raw id as the key fails 3 tests including this one |
| V2 | **VACUOUS** — the "empty session cookie" block in `session-cookie.spec.ts` passed for *any* input (the stub answered `null` regardless), and its comment claimed a key-level check it never made | **Deleted from that file**, and replaced with a real-path test in `session-redis.auth-strategy.spec.ts`. First two replacement attempts were *also* vacuous — one mirrored the production gate instead of exercising it, the second double-wrapped the cookie helper, whose `''` argument means "no header at all" — and both were caught by mutation, not by reading. Final form asserts **no Redis lookup happens** for an empty cookie. Mutation: removing `if (!sessionId) return null` fails it, restore passes |
| V3 | **INACCURATE COMMENT** — `repository-contract.ts:9-11` and `sequelize-factory.ts:10-13` claimed the SQL adapters are verified against the migration SQL alone | Both corrected: the schema under test is migrations **plus** `alignSchemaWithAdapters`, so the suite proves the adapters *agree* — not that the shipped migration produces the schema they agree on |
| V4 | **INACCURATE COMMENT** — `login-lockout.integration-spec.ts:227` said "no S-number yet" for a finding the ledger already assigned **S21** | Corrected to name S21 |
| V5 | **INACCURATE COMMENT** — `migrations-schema.integration-spec.ts:7-9` claimed it "compares the two directly"; it never reads `schema.prisma` | Corrected: `SCHEMA_COLUMNS`/`UNIQUE_KEYS` are a hand-written transcription, so it catches **migration-side drift only** — a column added to `schema.prisma` passes silently. Recorded as open work |
| V6 | **VACUOUS (minor)** — `rbac.seed.spec.ts` tested a transcription of the seeder's private `resolveGrant` rule, not the rule | Header comment corrected to state exactly that: it validates the baseline *data* against the rule's grammar (real value — a bad grant name is a boot-time failure), and does **not** track the seeder's code |

V2 is worth dwelling on: **the first two attempts to fix a vacuous test were themselves
vacuous, and only mutation caught them.** Reading the code would not have. That is
`orchestrate-skill.md` §10 earning its place — a green test proves nothing about *what* it pins.

### Wave 9 final gate (after the verifier fixes)

```
pnpm exec tsc --noEmit -p tsconfig.json  0
pnpm exec oxlint src/ test/              0
pnpm test                                29 files / 256 passed
pnpm test:contract                        4 files / 108 passed
pnpm test:integration                     6 files /  46 passed  (+2 expected fail)
pnpm test:e2e                             2 files /  82 passed  (+2 expected fail)
pnpm test:smoke                           16/16 checks, exit 0
pnpm build                                0
node dist/main.js                         boots; /auth/register → 201, /auth/me → 401
```
`git diff --stat src/` is `main.ts` (the Wave 0 `configureApp` extraction) plus one spec file —
no production file was changed by this wave except that extraction.

---

## Wave 10 — production fixes surfaced by the test suite ✅ (2026-09-14)

The Wave 9 suite did its job: it found defects that had been invisible for eight waves. This
wave fixes the ones worth fixing rather than only recording them, per the user's direction
("do whatever you think is most right for this project"). **Every change below is a deliberate
production change**, not a test-only edit — this is the first wave since Wave 8 to touch
runtime behaviour.

### 1. S17 + S18 — the migrated schema now matches what all four adapters declare

**New migration:** `src/database/migrations/20260914000001_timestamptz_and_column_defaults/`

Two deliberate, DB-side changes:

- **Column defaults.** `20260911000000_init` gave no default to any `id` column, nor to
  `users.updated_at` / `roles.updated_at`. `drizzle/schema.ts` declares `.defaultRandom()` and
  `.defaultNow()` and emits `DEFAULT` in its inserts, and `DEFAULT` against a column with no
  default is NULL — so **`DB_PROVIDER=drizzle` could not insert a single row**, and 22 of its
  27 contract tests failed. `gen_random_uuid()` (built in from PG 13) and `now()` are now
  DB-side. This is inert for Prisma and Sequelize, which supply both values client-side.
- **`TIMESTAMP(3)` → `TIMESTAMPTZ(3)`**, with `USING … AT TIME ZONE 'UTC'` stating the
  assumption the old data was written under (both Prisma and node send UTC wall-clock). The
  migration was the odd one out against Drizzle's `withTimezone: true` and Sequelize's
  `DataTypes.DATE` → `timestamptz` — and it was the wrong one. `timestamptz` is what Postgres
  and Prisma both recommend, and this was not merely cosmetic: node-pg parses a **zoneless**
  timestamp as *local* time, so on this non-UTC host the same instant round-tripped shifted
  through Drizzle and Sequelize while Prisma read it as UTC.

**Also changed to match:** `src/database/prisma/schema.prisma` — every `DateTime` is now
annotated `@db.Timestamptz(3)`, so `prisma migrate` cannot drift back.

**Deleted:** `alignSchemaWithAdapters()` in `test/contract/support/postgres-admin.ts`.

That deletion is the point of the whole item. The contract suite was passing for Drizzle only
because a **test-time patch** rewrote the schema to match Drizzle's own declarations — i.e. the
suite proved the adapters agreed *given a schema production did not have*. With the fix in a
real migration, the DDL replayed is the DDL that ships, and a reappearance of either drift
fails the suite instead of being patched away.

**Evidence it is load-bearing:** removing just this migration turns the contract suite into
**23 Drizzle failures** (`null value in column "id" of relation "users" violates not-null
constraint`); restoring it returns 108/108 across all four providers.

### 2. S19 — `refresh` now fails closed on a Redis outage

`src/auth-strategies/session-redis/session-redis.auth-strategy.ts`

`validateRequest` caught Redis failures and answered a clean 401; `refresh` did not, so the
same outage produced a raw ioredis error through the exception filter (≈500) on the refresh
path. A dead Redis cannot mean *"you are logged out"* on every guarded route while meaning
*"the server broke"* on refresh. `refresh` now goes through
`asUnauthenticatedOnRedisFailure`, which re-throws an existing `UnauthorizedException`
untouched (so a genuinely invalid credential keeps its own message) and maps anything else to
the same `Session is invalid or expired` 401.

**A test had to be inverted.** `test/integration/session-redis.integration-spec.ts` contained
`surfaces an unreachable Redis from refresh as a driver error, not a clean 401` — it pinned the
**bug** as expected behaviour. That is the Wave 6 `isSystem` anti-pattern in miniature: a
passing test that encodes a defect as the rule. It now asserts the fix (`UnauthorizedException`,
same message as `validateRequest`), so the two paths cannot drift apart again.

### 3. S22 — the app now releases its connections on shutdown

Nothing implemented a teardown hook, so `app.close()` released nothing and the process never
exited. Three deliberate changes:

| File | Change |
|---|---|
| `src/database/database.module.ts` | `DatabaseLifecycle` (`OnApplicationShutdown`) closes whichever client `DB_PROVIDER` built |
| `src/common/security/login-attempt.service.ts` | implements `OnModuleDestroy`; quits its own client |
| `src/rbac-strategies/rbac-strategies.module.ts` | `RedisClientLifecycle` quits `REDIS_CLIENT`; the Redis-free stub answers `quit` as a no-op, so shutdown is uniform |

`closeDbClient` dispatches on the client's **shape, not `instanceof`** — deliberately. The same
package resolved through two module registries yields two distinct constructors, so a valid
`PrismaClient` fails `instanceof PrismaClient` and silently falls through to the wrong branch.
That is not hypothetical: the first implementation used `instanceof` and broke the e2e suite
with `Cannot read properties of undefined (reading 'end')`. Each of the four handles has a
distinctive method (`$client.end` / `$disconnect` / `close` + `readyState`), so it asks for the
method.

**The smoke script is the proof.** `test/smoke/boot.smoke.ts` previously needed a forced
`process.exit` because after all 16 checks passed the process **hung open indefinitely**. That
exit is now removed, and the script **exits on its own in ~13s**. If it ever starts hanging
again, teardown has regressed.

### 4. Unhandled ioredis error events

Both hand-built ioredis clients — `LoginAttemptService`'s and `REDIS_CLIENT` — were constructed
with no `'error'` listener. `ioredis` is an EventEmitter, and an `error` event with no
subscriber is logged as `[ioredis] Unhandled error event`, which is what made the
deliberate "Redis DOWN ⇒ fails open" integration test print something that reads like a
failure. `withRedis` cannot cover this: it catches failures of individual *commands*, and this
is a separate, connection-level channel. Both now attach a listener that logs a warning and
does not throw.

### Deliberate test changes in this wave

- `test/support/e2e-setup.ts` + `test/support/harness.ts` — the ioredis stand-ins gained `on()`
  and `quit()`. A stand-in that cannot accept an error listener or a quit is not standing in
  for ioredis; adding the listener broke the e2e suite until the mock matched the interface.
- `src/common/security/login-attempt.service.spec.ts` — **3 new tests** driving the *real*
  `createClient` and `onModuleDestroy` (every prior test in that file replaced `createClient`
  through the subclass seam, so the new code would otherwise have been uncovered). Both are
  mutation-checked: removing the listener fails one, making `onModuleDestroy` a no-op fails the
  other. The coverage threshold caught this — `src/common/security/**` fell to 85.7% lines
  against a 96% floor, and the fix was to **add the tests, not lower the floor**.

### Wave 10 gate

```
pnpm build                               0
pnpm exec tsc --noEmit -p tsconfig.json  0
pnpm exec oxlint src/ test/              0
pnpm test                                29 files / 259 passed
pnpm test:contract                        4 files / 108 passed   ← against the unpatched schema
pnpm test:integration                     6 files /  46 passed  (+2 expected fail)
pnpm test:e2e                             2 files /  82 passed  (+2 expected fail)
pnpm test:smoke                           16/16, exits on its own in ~13s
pnpm test:cov                             0 — all per-directory thresholds met
node dist/main.js                         boots; /auth/register → 201, /auth/me → 401
```

### Items closed by this wave

| Id | Was | Now |
|---|---|---|
| **S17** | `DB_PROVIDER=drizzle` cannot insert against the migrated schema | **FIXED** — migration + Prisma schema annotation; suite runs unpatched |
| **S18** | Migration/ORM timestamp-type drift (zoneless, host-dependent shift) | **FIXED** — `TIMESTAMPTZ(3)` |
| **S19** | `refresh` does not fail closed on a Redis outage | **FIXED** — 401, matching `validateRequest` |
| **S22** | No `onModuleDestroy`; `app.close()` leaks Prisma/Redis handles | **FIXED** — three lifecycle hooks; smoke exits unaided |
| — | Unhandled ioredis `error` events on both hand-built clients | **FIXED** — listeners attached |

### Still open, deliberately not fixed here

- **S20** (a soft-deleted account permanently reserves its email) — the clean fix is a partial
  unique index `WHERE deleted_at IS NULL`, which is a **product decision** about whether an
  address becomes reusable after deletion. Not mine to make silently. Pinned by a test.
- **S21** (deactivating an account does not revoke its live session) — the fix is a design
  choice (re-read the account on every `validateRequest`, defeating the session cache, or revoke
  sessions on a deactivation path that does not exist yet). Quarantined with `it.fails`.
- **S2**, **S13** — unchanged, still quarantined and tracked.
