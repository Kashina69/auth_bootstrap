# TEST-PLAN.md — Building out the test suite (NestJS 12 + Fastify)

**Who this is for:** an orchestrator agent running a fresh chat, told to "write proper tests for
this project". It is a build plan, not a manifesto — it says what is missing, in what order to
build it, which agent owns which file, and what "done" means.

**Naming note:** an architecture `plan.md` already exists in this folder. This file is
deliberately `TEST-PLAN.md` so the two are never confused.

**Read first:** `orchestrate-skill.md` (dispatch mechanics — everything in §4–§8 there still
applies), `CONTRACTS.md` (the interfaces under test, §9 = the security invariants), `MEMORY.md`
(why the code is shaped this way), `WAVE-LOG.md` (open item S13 and the S1–S15 table).

---

## 1. Where the suite actually stands (verified at HEAD `0e05f43`)

```
pnpm test      → 17 files / 142 tests   (vitest.config.ts,     include: **/*.spec.ts)
pnpm test:e2e  →  1 file  /  42 tests   (vitest.config.e2e.ts, include: **/*.e2e-spec.ts)
```

Do not trust those numbers from this file — re-run them and record the real baseline before
changing anything. `orchestrate-skill.md` §7 is the gate.

**What already exists and is genuinely good — do not rewrite it:**

| Area | Coverage | Quality |
|---|---|---|
| `rbac-core/can.spec.ts` | `can()` semantics, `manage:all`, case-sensitivity, deny-by-default | Strong |
| `jwt-stateless.auth-strategy.spec.ts` | **RefreshTokenService** (hash-only storage, rotation within a family, replay → whole-family revocation, unknown/expired) **and JWT pinning** (RS256 keypair, HS256-forged-with-the-public-key algorithm confusion, wrong issuer/audience) | **Excellent — this is the security spine and it is properly tested** |
| `session-redis.auth-strategy.spec.ts` | session issue/validate/refresh/logout, hash-not-id-at-rest, fail-closed on Redis error, cross-user logout refusal | Strong |
| `db-live` / `embedded-claims` provider specs | cache hit/miss/invalidate, deny-by-default on malformed claims | Strong |
| `auth.service.spec.ts`, `authz.service.spec.ts`, `rbac-admin.service.spec.ts` | credential flow, indistinguishable failure messages, `isSystem` baseline protection | Strong |
| `auth.guard.spec.ts`, `rbac.guard.spec.ts` | `@Public()` bypass, 401 path, `req.user` assignment, both transports | Good |
| `test/auth.e2e-spec.ts` | 42 tests, the same file run **once per `AUTH_STRATEGY`**, real `AppModule`, real HTTP | Good — but REST-only, see §3.2 |

The unit layer is in good shape. **The gaps are structural, not incremental** — see §3.

---

## 2. Testing philosophy for this codebase

Three rules that follow from how this project was built and what it got wrong before.

### 2a. Test invariants and behaviour, never lines

`orchestrate-skill.md` §8 records that a green gate (build + test + tsc + oxlint + boot) missed
**three runtime crashes** in Wave 7, and that a passing test once *encoded a security bug as
correct behaviour* (the `isSystem` defect, Wave 6). A test that pins the current implementation
is worse than no test: it makes the bug look intentional.

So: assert on **what the system must never do**, phrased so that a wrong implementation fails.
`expect(await can(ctx, 'update', 'Post')).toBe(false)` is a real test.
`expect(service.isBaselinePermission).toHaveBeenCalled()` is not.

### 2b. Mutation-check every security assertion

For any test guarding a security property, force the condition false, confirm the test **fails**,
then restore. Report the mutation as evidence, not just "tests pass" (`orchestrate-skill.md`
§10). This is the only way to know a security test is load-bearing. The `isSystem` fix was
verified exactly this way.

### 2c. Prefer the real path over a synthetic one

`orchestrate-skill.md` §9a: two false alarms in this project came from probes that *could not*
have shown the thing being claimed (an introspection query that bypassed the depth limiter; a
hand-built execution context that passed while the live HTTP path crashed). Before writing a
test, ask: *if this were broken, would my test print something different?* If not, it is
decoration.

---

## 3. Gap analysis — the verified holes, ranked by risk

Each of these was confirmed by inspection at HEAD, not assumed.

### 3.1 🔴 The entire `src/database/` layer has **zero** tests

```
find src/database -name "*.spec.ts" | wc -l   # → 0
```

That is 16 repository implementations across four ORMs (Prisma, Drizzle, Sequelize, Mongoose),
the schemas/models, `database.module.ts`, and the seed. **Nothing executes them.** Worse: the
e2e suite substitutes the persistence boundary with in-memory fakes, so the real adapters are
never run by *any* test in the repo.

Consequences that are already real, not hypothetical:

- `DB_PROVIDER=drizzle|sequelize|mongoose` is an advertised, headline feature
  (`README.md`, `plan.md` §3) that has never been executed end-to-end.
- Item **S10** in `WAVE-LOG.md` — *"Mongoose normalizes email in-adapter; the other three do
  not"* — is a known behavioural divergence between adapters that nothing detects. A contract
  suite turns that from a note into either a fix or a deliberate, documented exception.
- Item **S11** (seed `findOrCreatePermission` never updates existing rows) is untested.
- The `is_system` migration (Wave 6) was never verified against a real database.

**This is the single highest-value work in this plan.** See §5 Wave 1.

### 3.2 🔴 The e2e suite never exercises GraphQL

```
grep -c "graphql" test/auth.e2e-spec.ts   # → 0
```

GraphQL parity is a headline architectural claim (`plan.md` §10: "neither transport can drift
from the other"), it has its own resolver files, its own DTO-input decorators, its own throttler
guard, and a documented history of three separate runtime crashes that only a real request
surfaced. And the e2e suite does not touch it.

**It would have caught S13.** That open item — GraphQL `variables` never reach the server — was
found by hand in Wave 7 and is still open. A GraphQL e2e with a variable-bearing query is a
five-line test that fails today.

### 3.3 🟠 Coverage is measured by nothing

`@vitest/coverage-v8` and a `test:cov` script exist, but there is **no `coverage` block in
either vitest config, no thresholds, and coverage is not in the gate**. Nobody knows what the
suite actually reaches, so the gaps above stayed invisible.

### 3.4 🟠 Untested units on the security path

Files with no spec of their own (the strategy specs cover some of this indirectly, which is why
this is 🟠 and not 🔴):

| File | Why it matters |
|---|---|
| `auth-strategies/jwt-stateless/token.service.ts` | the only place `algorithms`/`issuer`/`audience` are set. Covered indirectly via the strategy spec; a direct spec makes the pinning explicit and survives refactors of the strategy |
| `auth-strategies/session-redis/session-store.ts` | the SHA-256 key hashing and the `SET … EX` atomicity claim |
| `auth-strategies/session-redis/session-cookie.ts` | hand-rolled cookie parsing — an untested parser on the authentication path |
| `rbac-strategies/db-live/authz-context-cache.ts` | cache-key construction; a collision here is a cross-user permission leak |
| `common/interceptors/transform.interceptor.ts` | the `{ data, meta }` envelope the **client depends on** (`../client/src/lib/api.ts` unwraps it) |
| `common/interceptors/timeout.interceptor.ts` | has real timing behaviour and no test at all |
| `common/decorators/*.ts` | `@Permissions()` parsing is tested inside `rbac.guard.spec.ts`; `@Public`, `@Roles`, `@CurrentUser` are not |
| `database/seed/rbac.seed.ts` | idempotency is the whole point of the seed |
| `modules/*/dto/*.ts` | validation rules (password strength, `whitelist`/`forbidNonWhitelisted`) are only covered incidentally by e2e |

### 3.5 🟠 The e2e harness duplicates `main.ts` and drifts from it

`test/auth.e2e-spec.ts` re-applies the global `ValidationPipe`, the three interceptors and the
exception filter **by hand**, because `main.ts` is not factored for reuse. Two consequences
already recorded in `MEMORY.md`:

- A new global enhancer added to `main.ts` is silently **not** covered by e2e until someone
  remembers to update the spec.
- The `session-redis` CSRF registration is the one piece deliberately **not** reproduced, so
  that path has no test at all.

Fix: extract `configureApp(app)` from `main.ts` and call it from both. See §5 Wave 0.

### 3.6 🟡 Live-service paths

No Postgres and no Redis are available in the dev environment, so: real Redis behaviour
(session TTL, sliding expiration, lockout counters, the `db-live` cache TTL) and real SQL
(migrations, constraints, soft-delete filtering, unique-email enforcement, transaction
behaviour) have never run. Item S2's cookie transport also has no coverage.

### 3.7 🟡 Flakiness hazards not yet designed for

Not a gap in coverage but a trap for whoever builds §3.1/§3.6: this suite uses **argon2** (a slow
native KDF), **real timers** (timeout interceptor, throttle windows, lockout windows), and
**shared mutable state** (one in-memory store per `describe` block). Naïve additions will be
slow and flaky. §7 sets rules up front.

---

## 4. The test taxonomy — six kinds, each with a home

Decide the kind *before* writing, so tests land in the right config and run at the right cost.

| Kind | What it proves | Config | Location |
|---|---|---|---|
| **1. Unit** | one function/class in isolation, deps faked | `vitest.config.ts` | `src/**/*.spec.ts` (as today) |
| **2. Adapter contract** | *all four* ORM adapters satisfy the same interface identically | new `vitest.config.contract.ts` | `test/contract/**` |
| **3. Integration (live services)** | real Redis + real Postgres behaviour | new `vitest.config.integration.ts` | `test/integration/**` |
| **4. E2E REST** | the HTTP surface through the real `AppModule` | `vitest.config.e2e.ts` | `test/**/*.e2e-spec.ts` (as today) |
| **5. E2E GraphQL** | the GraphQL surface, and that it matches REST | `vitest.config.e2e.ts` | `test/**/*.e2e-spec.ts` |
| **6. Boot smoke** | the app actually starts and maps its routes | script, in the gate | `test/smoke/` |

Kinds 2, 3 and 6 do not exist at all today. Kind 5 does not exist. They are the plan.

---

## 5. The waves

Sequenced per `orchestrate-skill.md` §2/§4: nothing parallel shares a file, interfaces are frozen
before dispatch, and anything under ~10 lines stays with the orchestrator (§6a).

### Wave 0 — prerequisites (orchestrator, no agents)

Everything else is blocked on these three, and they are each small.

1. **Extract `configureApp(app)` from `main.ts`** and call it from both `main.ts` and the e2e
   harness (§3.5). This is the change that makes kind 4 and 5 honest. Verify the existing 42 e2e
   tests still pass **unmodified** before moving on.
2. **Add a `test` service stack** — `docker-compose.test.yml` with Postgres + Redis, plus
   `test:services:up` / `down` scripts. Include a `redis-cli ping` + `pg_isready` readiness
   check; a test run against a half-started Postgres produces confusing failures rather than
   clean ones.
   **There is no compose file in the repo today** — `setup.md` documents plain `docker run`
   commands (`postgres:16` on `5432`, `redis:8` on `6379`, containers named `auth-postgres` /
   `auth-redis`). **Use different host ports for the test stack** (e.g. `55432` / `56379`) so a
   developer's running dev stack does not silently become the test database — that failure mode
   shows up as "tests pass locally, destroy my data", and it is worth the two extra port
   numbers. Match the same image versions `setup.md` pins.
3. **Add the coverage block and thresholds to both configs** (§6). Start the thresholds at
   whatever the suite currently achieves, so they ratchet rather than red-line on day one.

*Gate: existing gate green, `docker compose -f docker-compose.test.yml up -d` healthy, `test:cov`
produces a report.*

### Wave 1 — the adapter contract suite 🔴 (highest value; 1 agent + orchestrator review)

**One test file, four providers** — the same trick Phase 13 used for strategies, applied to
persistence. This is the answer to §3.1.

Shape:

```ts
// test/contract/repository-contract.ts   — no framework, no ORM, just assertions
export function defineRepositoryContract(
  name: string,
  createRepositories: () => Promise<{
    users: UserRepository; roles: RoleRepository;
    permissions: PermissionRepository; refreshTokens: RefreshTokenRepository;
    reset: () => Promise<void>;
  }>,
): void { /* describe() with the full behavioural contract */
}
```

```ts
// test/contract/prisma-repository.contract-spec.ts
defineRepositoryContract('prisma', () => createPrismaRepositories(TEST_DATABASE_URL));
// …and three more, one per provider
```

The contract must assert the behaviour `CONTRACTS.md` §5 *promises*, not what any one adapter
happens to do:

- **not-found normalizes to `null`** — never an ORM-specific exception, in every `find*`
- **the soft-delete filter** — `findById`/`findByEmail` return `null` for a `deletedAt`-set user
  (a deactivated account must not authenticate; three adapters originally got this wrong)
- `assignRole` is **idempotent**
- `attachPermissions` / `detachPermissions` are idempotent, and `detach` actually removes
- `findRolesAndPermissions` returns role and permission **names**
- `findUserIdsByRole` returns exactly the holders
- refresh tokens: **only the SHA-256 hash is ever persisted**, `revokeFamily` and
  `revokeAllForUser` are scoped correctly
- `create` on a `Permission`/`Role` round-trips `isSystem`
- **email handling (the S10 decision point).** The contract suite will expose that Mongoose
  normalizes email in-adapter while the other three do not. Do **not** paper over it: either
  make all four consistent or write the divergence into `CONTRACTS.md` §5 as an explicit,
  intentional exception with the service-boundary normalization as the reason. A silent
  `expect` that differs per provider defeats the purpose of a contract suite.

Assign the **orchestrator** to write `repository-contract.ts` (it is the interface everyone codes
against — `orchestrate-skill.md` §4 says freeze interfaces yourself), then dispatch **four
parallel agents**, one per adapter, each owning exactly one `*-repository.contract-spec.ts` plus
the `reset()`/factory helper for its provider. No two agents touch the same file.

Some providers need schema setup before assertions: run the repo's migrations for Postgres
providers, and have the Mongoose factory create/drop its collections. Do that **inside each
provider's factory**, not in the shared contract.

*Gate: all four contract specs green against live services; mutation-check the soft-delete and
hash-at-rest assertions.*

### Wave 2 — GraphQL e2e 🔴 (1 agent, sequential, depends on Wave 0's `configureApp`)

Mirror the REST e2e for the GraphQL transport, in `test/auth.e2e-spec.ts` or a sibling file that
reuses the same in-memory stores and harness:

- the four auth **mutations** (`register`, `login`, `refresh`, `logout`) and the **queries**
  (`me`, `checkPermission`)
- **a query using GraphQL variables** — this is the S13 regression test and it fails today
- the guarded `me`/`checkPermission` reachable unauthenticated → `Unauthorized` in `errors[]`
- throttle the GraphQL `login` mutation and assert it is limited (Wave 7 established GraphQL is
  **not** a rate-limit bypass — pin that, because "fixing" a GraphQL throttler crash by skipping
  non-HTTP contexts is an auth bypass, not a convenience)
- **parity**: for each operation, the GraphQL result must match the REST result for the same
  input. That is the actual architectural claim; test the claim, not the endpoints

Expect S13 to fail on first run. That is the test doing its job. Either fix S13 in this wave or
mark the test `it.fails(...)`/skipped with a link to the open item — but do not delete it.

*Gate: GraphQL e2e green (or S13 explicitly quarantined with a tracked reason).*

### Wave 3 — live-service integration 🟡 (1–2 agents)

Against the real stack, for behaviour in-memory fakes cannot prove:

- **`session-redis` end-to-end with real Redis** — session TTL, sliding expiration on refresh,
  logout deletes the key, a deactivated user's session stops working
- **lockout** (`LoginAttemptService`, spec §6): 10 failures in the window → locked; the message
  is identical to a wrong password; the window expires; Redis down ⇒ **fails open** (a dead
  Redis must not lock everyone out — that is a deliberate design decision, so pin it)
- **`db-live` cache**: 5s TTL, and `invalidate()` makes an admin change visible immediately
- **S2's cookie transport** — this is the one that will not pass as written. `createSessionCookieOptions()`
  is never called (S2, High severity, open). Write the test to assert the *intended* behaviour,
  watch it fail, and let that failure drive the contract decision. If the team defers, mark it
  skipped with the item number — an untested known hole is acceptable; an unknown one is not
- migrations produce a schema matching the ORM definitions; the unique-email constraint is real
  (S11's `findOrCreatePermission` behaviour belongs here too)

*Gate: green against live services, or each deferral explicitly skipped with its S-number.*

### Wave 4 — coverage ratchet + the unit gaps of §3.4 (1 agent, or orchestrator)

Cheap, mechanical, and it should come last so the thresholds reflect the finished suite. Write
the missing direct specs for the §3.4 table, then raise the coverage thresholds to the new floor.
Prioritise by blast radius: `session-cookie.ts` (hand-rolled parser on the auth path),
`authz-context-cache.ts` (key collision = cross-user leak), `token.service.ts` (the pinning),
`transform.interceptor.ts` (client-visible contract) — then the decorators, DTOs and seed.

*Gate: `test:cov` meets the ratcheted thresholds; every §3.4 file has a spec or a recorded reason
it does not.*

### Wave 5 — boot smoke + wire into the gate (orchestrator)

Kind 6: a script that boots `dist/main.js`, asserts the route map (`/auth/*`, `/authz/check`,
`/rbac-admin/*`, `/graphql`), asserts a clean exit on shutdown, and runs in CI. It is ~20 lines
and catches the class of failure that `build`+`test` cannot (`orchestrate-skill.md` §7 — Wave 6
learned this when the Apollo driver needed `@as-integrations/fastify` merely to start).

Then update `orchestrate-skill.md` §7's gate block to include `test:contract`,
`test:integration` and `smoke`.

---

## 6. Coverage policy

Measure it, but **do not chase a global number.** This codebase has thin, well-tested core
layers and thick, largely untested adapter layers; a single percentage hides exactly the
distinction that matters.

Configure **per-directory thresholds** on the security-critical surface only:

| Path | Why it is the one that matters |
|---|---|
| `src/rbac-core/**` | `can()` is the sole deny-gate. Already near-total; keep it at 100% |
| `src/auth-strategies/**` | credential issue/validate/rotate |
| `src/rbac-strategies/**` | permission resolution |
| `src/common/security/**` | argon2, lockout |
| `src/common/guards/**` | the enforcement points |

Exclude `*.module.ts`, `*.types.ts`, `main.ts` and generated schema files. Do **not** set a
threshold on `src/database/repositories/**` — Wave 1 covers those behaviourally through the
contract suite, which is a stronger guarantee than line coverage and does not need a number.

State plainly in the config comment: **coverage is a gap-finder, not a gate on correctness.** The
Wave 6 `isSystem` defect sat behind a fully-covered, fully-green file.

---

## 7. Flakiness and timing rules (set these before writing, not after)

This suite has unusual hazards. Rules, all of which follow from the stack:

1. **Never wrap argon2 in `vi.useFakeTimers()`.** It is a native async KDF; faking timers
   deadlocks the await. Fake timers are fine for the throttle window, lockout window and
   `TimeoutInterceptor` — not around password hashing.
2. **Inject a clock rather than faking time** in new code where practical; the existing
   `LoginAttemptService` uses real Redis TTLs, so its tests should use a **short real window**
   (a test-only env override) rather than fake timers.
3. **Keep the argon2 cost down in tests.** If the suite gets slow, lower `memoryCost`/`timeCost`
   **only in the test env** — never in production defaults — and never below the point where the
   hash format still validates.
4. **Isolate database state per test.** Truncate between tests, or wrap each test in a
   transaction that rolls back. Do **not** rely on test ordering, and do not share a
   `describe`-level store the way the current e2e does — that pattern is fine for in-memory
   fakes and dangerous against a real database.
5. **Give each vitest worker its own database/schema** (or force `--no-file-parallelism` for
   integration runs). Parallel workers sharing one Postgres is the classic source of
   "passes alone, fails together".
6. **Never assert on wall-clock durations.** Assert on state transitions and counts.
7. **Make `reset()` explicit in every adapter factory**, and call it in `beforeEach`, so a
   failing test cannot poison the next one.
8. **Keep the e2e suite's two-strategy structure.** One spec file, run per `AUTH_STRATEGY`, is
   the pattern that proved the strategies interchangeable — extend it, do not fork it.

---

## 8. Anti-patterns (all observed in this project's history)

| Anti-pattern | What it cost / would cost |
|---|---|
| A test that encodes a bug as expected behaviour | Wave 6: baseline permissions were deletable, and a passing test asserted the wrong rule |
| Trusting build+test green as a sufficient gate | 3 latent type errors across 2 waves; 3 runtime crashes invisible to the entire gate |
| A synthetic probe that cannot detect the failure it claims to test | 2 false alarms; one caused 62k of destroyed work |
| Adding tests to raise a coverage number | Tests that pin implementation, not behaviour — the opposite of §2a |
| Forking the e2e suite per strategy | Loses the interchangeability proof; two files drift |
| Weakening an assertion to make a new test pass | Especially in the port playbooks' oracle pattern — the whole point is that the assertion does not move |
| Testing a mock | Asserting the fake returned what you told it to. If the test would pass with the real dependency removed, it tests nothing |
| Leaving S13's test deleted because it fails | A red test with a tracked number beats a green suite with a blind spot |

---

## 9. Definition of done

- `pnpm test` (unit) green, count **greater than 142**, no existing assertion weakened.
- `pnpm test:contract` green — **four providers**, one shared contract.
- `pnpm test:integration` green against the docker stack, or each deferral skipped with its
  S-number.
- `pnpm test:e2e` green — the **original 42 assertions unchanged** plus the GraphQL suite.
- S13 either fixed or explicitly quarantined with a failing/skipped test referencing it.
- `test:cov` reports and meets the per-directory thresholds of §6.
- Boot smoke script in the gate; `orchestrate-skill.md` §7 updated to include the new commands.
- `MEMORY.md` + `WAVE-LOG.md` updated with the new gate results, every new test file, and any
  divergence the contract suite exposed (S10 especially — it must end as either a fix or a
  written exception in `CONTRACTS.md` §5).
- `README.md`'s script table updated with the new test commands.

## 10. Explicitly out of scope

Say no to these unless asked, because they are how a test-planning task quietly becomes a
two-week project:

- load / performance / soak testing
- mutation testing as an automated CI step (do it by hand per §2b, on security assertions only)
- contract testing between this service and `../client` beyond the `{ data, meta }` envelope
- fuzzing
- snapshot tests of the GraphQL schema (the schema is already written to `src/schema.gql` and
  reviewed in diffs — a snapshot adds noise, not safety)
