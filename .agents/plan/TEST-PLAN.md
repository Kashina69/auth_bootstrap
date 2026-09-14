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

## 0. How to consume this file

**Hand this to an orchestrator chat and say "build the test suite per TEST-PLAN.md".** This file
does not itself spawn anything — it is a specification an orchestrating agent executes. It
assumes the chat can spawn subagents and run them concurrently; that is the only harness
requirement. No other skill, plugin or tool is assumed.

**Granularity policy — one agent per SECTION, never per file.** This is the whole point of the
shape below, and it is the rule `orchestrate-skill.md` §1 already measured: *cost scales with
scope, not with layer count; splitting one task across N agents does not divide its cost N ways,
because every agent re-pays the orientation tax* (locating files, reading contracts) on top of
its share of the work.

So: **4 agents total**, one per section, dispatched **in parallel**, each owning a whole
directory of test work. Never one agent per adapter, per endpoint, or per spec file. The
sections in §5 were chosen so that no two agents share a file, which is what makes the
parallelism safe — not so that each agent has minimal scope.

| Do | Don't |
|---|---|
| One agent owns **all four** ORM adapter contract specs | Four agents, one per adapter |
| One agent owns the whole GraphQL e2e section | One agent per resolver |
| One agent owns the whole live-service integration section | One agent per Redis behaviour |
| One agent owns all remaining unit gaps | One agent per untested file |

**Context and cost expectations:** each section agent should land around **40–100k tokens**.
If one blows past ~150k, it has drifted outside its section — stop it and re-scope rather than
letting it keep going. §2 of `orchestrate-skill.md` has the measured per-agent figures this is
based on.

**The orchestrator's own job, unchanged from `orchestrate-skill.md` §13:** run the gate, do the
small wiring yourself, spot-check claims in one command rather than delegating, and own the
commits. §5's Wave 0 is orchestrator-only work and is the largest single piece of it.

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

## 5. The dispatch plan — Wave 0, then 4 parallel section agents

**Shape: one orchestrator-only prerequisite wave, then four agents dispatched simultaneously,
one per section.** Four agents, total. Not four per section — four *in total*.

### Wave 0 — prerequisites (orchestrator only, no agents)

Everything here is small, shared, and blocking. It is done by the orchestrator because **each
item is a file two or more section agents would otherwise fight over** — which is the actual
reason parallelism is safe afterwards.

| # | Task | Why it cannot be delegated |
|---|---|---|
| 1 | Extract `configureApp(app)` from `main.ts`; call it from `main.ts` **and** the existing e2e harness | §3.5. One file, two consumers — a shared boundary |
| 2 | Extract the e2e harness into `test/support/harness.ts` (`createTestApp()`, `authorize()`, the in-memory store wiring); refactor `auth.e2e-spec.ts` to use it | Same: agents B and C both need it and **must not edit it** |
| 3 | `docker-compose.test.yml` (Postgres 16 / Redis 8 on `55432`/`56379`) + `test:services:up`/`down` | Shared infrastructure |
| 4 | **Both** new vitest configs (`vitest.config.contract.ts`, `vitest.config.integration.ts`) **and all `package.json` scripts** | Otherwise agents A and C both edit `package.json` and both create a config — a guaranteed write race |
| 5 | Coverage block + ratcheted thresholds in both configs (§6) | Shared config |

*Gate: the existing 42 e2e assertions still pass **unmodified** after the harness refactor, and
`docker compose -f docker-compose.test.yml up -d` reports healthy.*

### Wave 1 — four agents, simultaneously

| Agent | Owns (a whole section) | Depends on |
|---|---|---|
| **A** `db-contract-agent` | `test/contract/**` — the shared contract file **and** all four provider specs | Wave 0 (docker, config, scripts) |
| **B** `graphql-e2e-agent` | `test/graphql.e2e-spec.ts` (+ any GraphQL-specific support files) | Wave 0 (harness) |
| **C** `integration-agent` | `test/integration/**` — Redis sessions, lockout, db-live cache, migrations, S2 | Wave 0 (docker, config, scripts) |
| **D** `unit-gap-agent` | New `*.spec.ts` beside the §3.4 source files | nothing |

**Shared-file rules that make this safe:**

- `test/support/**` is **frozen after Wave 0**. A–D import it; none may edit it. Needing a change
  means reporting back to the orchestrator, not editing (`orchestrate-skill.md` §4).
- `package.json`, both vitest configs, `main.ts` — **frozen after Wave 0**. Sections add no
  scripts and no config.
- A and D touch different trees entirely. B and C touch different files. No pair shares a file.

**If you want to go cheaper still:** drop D. It is the lowest-risk section, and its files can be
picked up later or folded into a follow-up. A, B and C are the ones that close real holes.

**Sizing guard:** each agent should land near **40–100k tokens**. Past ~150k it has left its
section — stop it and re-scope (`orchestrate-skill.md` §2). Do **not** subdivide a section that
is running long; that just multiplies the orientation tax.

### Wave 2 — orchestrator gate + one verifier

Run the full gate (§9). Then dispatch **one** diff-scoped adversarial verifier
(`orchestrate-skill.md` §8 Tier 1) over the whole wave's diff. Ask it the questions static checks
cannot answer:

- does any new test **pass with the implementation removed** (i.e. does it test a mock)?
- is the soft-delete assertion and the hash-at-rest assertion actually load-bearing — did anyone
  mutation-check them (§2b)?
- did the contract suite quietly weaken a per-provider expectation to make one adapter pass?
- was any existing assertion in `auth.e2e-spec.ts` modified?

Do **not** dispatch one verifier per section. One verifier, the whole diff.

---

### Dispatch prompts (copy-paste; each assumes Wave 0 is merged and green)

Every prompt follows `orchestrate-skill.md` §5: role, owned paths + do-not-touch, exact reads,
frozen interfaces copied in, environment constraints, style contract, verification command, and
a short report format. Paste `STYLE.md` inline in each rather than telling the agent to read it.

**A — `db-contract-agent`**

```
You are ONE OF FOUR agents running CONCURRENTLY in /home/prince/code/project/nest/auth.
You own the ENTIRE database contract-test section. No other agent will touch your files.

OWNED PATHS (create/edit only these):
  test/contract/repository-contract.ts          — the shared behavioural contract
  test/contract/{prisma,drizzle,sequelize,mongoose}-repository.contract-spec.ts
  test/contract/support/*.ts                    — per-provider factories + reset()

DO NOT TOUCH: test/support/**, test/auth.e2e-spec.ts, test/integration/**,
  vitest.config*.ts, package.json, main.ts, anything under src/.
  If you need a change in any of those, STOP and report it instead.

READ ONLY THIS (not the whole repo):
  .agents/plan/CONTRACTS.md §5 (repository contracts + entity shapes) and §9 (invariants)
  .agents/plan/TEST-PLAN.md §3.1, §5 Wave 1, §7
  src/database/repositories/user.repository.ts, role.repository.ts,
    permission.repository.ts, refresh-token.repository.ts
  ONE existing adapter per family, to learn its constructor:
    src/database/repositories/prisma-user.repository.ts, drizzle-user.repository.ts,
    sequelize-user.repository.ts, mongoose-user.repository.ts

DELIVERABLE: one shared contract file exporting defineRepositoryContract(name, factory),
plus four thin specs, one per DB_PROVIDER, each passing its own Docker-backed factory.
The contract must assert CONTRACTS §5 behaviour, NOT what one adapter happens to do:
  - every find* returns null when absent — never an ORM-specific exception
  - the SOFT-DELETE filter: findById/findByEmail return null for a deletedAt-set user
  - assignRole idempotent; attachPermissions/detachPermissions idempotent, detach removes
  - findRolesAndPermissions returns NAMES; findUserIdsByRole returns exactly the holders
  - refresh tokens: ONLY the SHA-256 hash is persisted; revokeFamily/revokeAllForUser scoped
  - create() round-trips isSystem on Role and Permission
  - email handling: if the four adapters DISAGREE, do NOT paper over it. Report the
    divergence with evidence — it is item S10 and it must become a fix or a written
    exception in CONTRACTS §5, not a per-provider expect().

ENVIRONMENT: ESM — every relative import needs a .js extension. Test DB is
  postgresql://...@localhost:55432 (docker-compose.test.yml, already running).
  Run migrations inside YOUR factories, never in the shared contract.

VERIFY WITH: pnpm exec tsc --noEmit -p tsconfig.json   (do NOT run pnpm build — agents
  run concurrently and would race on dist/)

REPORT (short): files created; the exact command + result; whether the four adapters
  agreed on email handling; anything you were blocked on. No essays.
```

**B — `graphql-e2e-agent`**

```
You are ONE OF FOUR agents running CONCURRENTLY in /home/prince/code/project/nest/auth.
You own the ENTIRE GraphQL e2e section.

OWNED PATHS: test/graphql.e2e-spec.ts (plus test/support/graphql-*.ts if you truly need
  a GraphQL-only helper).
DO NOT TOUCH: test/support/harness.ts (FROZEN — import it), test/auth.e2e-spec.ts,
  test/contract/**, test/integration/**, vitest.config*.ts, package.json, src/**.
  If src/ seems to need a change, STOP and report — that is a finding, not a task.

READ ONLY THIS:
  .agents/plan/TEST-PLAN.md §3.2, §5 Wave 1, §7
  .agents/plan/WAVE-LOG.md §Wave 6 + the S13 entry
  test/auth.e2e-spec.ts (the REST suite — mirror its structure and reuse the harness)
  src/schema.gql (the generated schema — the queries/mutations you must exercise)
  src/modules/auth/auth.resolver.ts, src/modules/auth/authz.resolver.ts

DELIVERABLE: the GraphQL half of the e2e suite, same file run once per AUTH_STRATEGY:
  - mutations: register, login, refresh, logout; queries: me, checkPermission
  - MUST include an operation that uses GraphQL VARIABLES, not just inline literals.
    This is the S13 regression test. Expect it to FAIL — that is the point. If it fails,
    either fix S13 (report it) or quarantine the single test with it.fails() plus a
    comment naming S13 and WAVE-LOG. Do NOT delete it and do NOT weaken it.
  - unauthenticated me/checkPermission -> Unauthorized inside errors[]
  - throttle the login mutation and assert it is limited: Wave 7 proved GraphQL is NOT a
    rate-limit bypass. Pin that property.
  - PARITY: for each operation, the GraphQL result must match the REST result for the
    same input. That is the actual architectural claim (plan.md §10) — test the claim.

ENVIRONMENT: ESM — .js extensions on relative imports. GraphQL goes through
  @as-integrations/fastify; it is already wired and boots.

VERIFY WITH: pnpm exec tsc --noEmit -p tsconfig.json, then
  pnpm exec vitest run --config ./vitest.config.e2e.ts
  (never pnpm build — agents run concurrently and would race on dist/)

REPORT (short): files created; exact command + result; S13 status (fixed / quarantined);
  any REST-vs-GraphQL divergence you found. No essays.
```

**C — `integration-agent`**

```
You are ONE OF FOUR agents running CONCURRENTLY in /home/prince/code/project/nest/auth.
You own the ENTIRE live-service integration section.

OWNED PATHS: test/integration/** (plus test/integration/support/**).
DO NOT TOUCH: test/support/**, test/contract/**, test/auth.e2e-spec.ts,
  test/graphql.e2e-spec.ts, vitest.config*.ts, package.json, src/**.
  If src/ seems to need a change, STOP and report it.

READ ONLY THIS:
  .agents/plan/TEST-PLAN.md §3.6, §5 Wave 1, §7 (flakiness rules — follow them exactly)
  .agents/plan/CONTRACTS.md §9 (security invariants)
  .agents/plan/WAVE-LOG.md — items S2, S9, S10, S11
  src/common/security/login-attempt.service.ts
  src/auth-strategies/session-redis/{session-store,session-cookie}.ts
  src/rbac-strategies/db-live/{db-live.authorization-provider,authz-context-cache}.ts

DELIVERABLE — real Redis, real Postgres:
  - session-redis with REAL Redis: TTL set, sliding expiration on refresh, logout deletes
    the key, a deactivated user's session stops working
  - lockout (spec §6): 10 failures in the window -> locked; message IDENTICAL to a wrong
    password; window expiry; and Redis DOWN => FAILS OPEN (deliberate — a dead Redis must
    not lock everyone out. Pin it.)
  - db-live cache: 5s TTL, and invalidate() makes an admin change visible immediately
  - migrations vs ORM definitions: schema matches; the unique-email constraint is real
  - S2 (session cookie never attached): write the test for the INTENDED behaviour, watch
    it fail, and report it. If deferring, skip it with a comment naming S2 — an untested
    known hole is acceptable; a silently missing test is not.

ENVIRONMENT: ESM — .js extensions. Test stack is docker-compose.test.yml:
  Postgres localhost:55432, Redis localhost:56379 (already running).
  NEVER use fake timers around argon2 — it is a native async KDF and will deadlock.
  Use a short REAL lockout window via a test-only env override instead.

VERIFY WITH: pnpm exec tsc --noEmit -p tsconfig.json, then
  pnpm exec vitest run --config ./vitest.config.integration.ts
  (never pnpm build — agents run concurrently and would race on dist/)

REPORT (short): files created; exact command + result; S2 outcome; anything deferred with
  its S-number. No essays.
```

**D — `unit-gap-agent`**

```
You are ONE OF FOUR agents running CONCURRENTLY in /home/prince/code/project/nest/auth.
You own the remaining unit-test gaps. You touch ONLY new spec files — no source edits.

OWNED PATHS: new *.spec.ts files sitting beside these sources:
  src/auth-strategies/session-redis/session-cookie.ts
  src/auth-strategies/session-redis/session-store.ts
  src/auth-strategies/jwt-stateless/token.service.ts
  src/rbac-strategies/db-live/authz-context-cache.ts
  src/common/interceptors/{transform,timeout}.interceptor.ts
  src/common/decorators/{public,roles,current-user}.decorator.ts
  src/modules/*/dto/*.dto.ts
  src/database/seed/rbac.seed.ts
DO NOT TOUCH: any non-spec source file. DO NOT TOUCH test/**, vitest.config*.ts,
  package.json. If a test reveals a SOURCE bug, STOP and report — do not fix src/.

READ ONLY THIS:
  .agents/plan/TEST-PLAN.md §3.4, §7
  src/common/interceptors/logging.interceptor.spec.ts  (the in-repo pattern to follow)
  the source files listed above.

PRIORITISE BY BLAST RADIUS, in this order:
  1. session-cookie.ts — a hand-rolled cookie parser on the authentication path
  2. authz-context-cache.ts — a key collision is a CROSS-USER PERMISSION LEAK
  3. token.service.ts — the only place algorithms/issuer/audience are pinned
  4. transform.interceptor.ts — the { data, meta } envelope the Next.js client depends on
  5. the rest (decorators, DTO validation rules, seed idempotency)
Assert BEHAVIOUR AND INVARIANTS (TEST-PLAN §2a), never that a mock returned what you told
it to. A test that would still pass with the implementation deleted is a defect.

ENVIRONMENT: ESM — .js extensions on relative imports. Never fake timers around argon2.

VERIFY WITH: pnpm exec tsc --noEmit -p tsconfig.json, then pnpm test
  (never pnpm build — agents run concurrently and would race on dist/)

REPORT (short): files created; exact command + result (file/test counts); any source bug
  you found but did NOT fix. No essays.
```

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
