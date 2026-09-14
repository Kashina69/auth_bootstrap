# PORT-FRAMEWORK.md — Porting this service to any non-NestJS framework

**Scope:** leaving NestJS. Target is Hono, Next.js route handlers, Elysia/Bun, bare Express, or
anything else. Nest's DI, modules, guards, pipes, interceptors, filters and decorators all go
away and are replaced by that framework's own idioms.

**If the target is NestJS + Express**, you want `PORT-EXPRESS.md` instead — that is a two-hour
adapter swap, and this file will make you do ten times the work for the same result.

**This file is written to be handed to an orchestrator agent.** It tells you what is invariant,
what is shell, how to sequence the rewrite, and what "done" means. Dispatch mechanics live in
`orchestrate-skill.md`; the frozen interfaces in `CONTRACTS.md`; the style contract in
`STYLE.md`. Read all three first.

---

## 1. The one idea that makes this port tractable

This codebase was built around a pluggable-strategy design, and the side effect is that **most
of it does not know NestJS exists.** Measured, not assumed:

```bash
grep -rln "@nestjs" src/rbac-core/ src/database/repositories/   # → NOTHING
grep -c "@Injectable\|@Inject\|@Module" \
  src/auth-strategies/jwt-stateless/jwt-stateless.auth-strategy.ts \
  src/auth-strategies/session-redis/session-redis.auth-strategy.ts \
  src/rbac-strategies/*/*.authorization-provider.ts              # → 0, 0, 0, 0
```

- **`src/rbac-core/`** (5 files: `can()`, `hasRole()`, `hasAnyPermission()`, types,
  policy-registry) — zero dependencies of any kind.
- **The entire repository layer** — 4 frozen contracts and all four ORM adapter families
  (Prisma, Drizzle, Sequelize, Mongoose) — zero Nest imports.
- **All four strategy classes are plain classes with no decorators at all.** Constructing
  `new SessionRedisAuthStrategy(redis, config)` is valid TypeScript today, outside any container.
- The **services** (`AuthService`, `AuthzService`, `RbacAdminService`, `PasswordService`) carry
  `@Injectable()`/`@Inject()` purely for wiring. Strip those decorators and the method bodies
  are unchanged.

So the port is **not** a rewrite of the auth logic. It is a rewrite of the *shell* around it.
Budget accordingly, and resist any agent that proposes reimplementing `can()` or a repository.

**The three layers:**

| Layer | What it is | Port action |
|---|---|---|
| **1. Invariant core** | `rbac-core`, repositories + adapters, the 4 strategies, the service classes' method bodies, migrations, seed JSON | **Carry over unchanged.** Any edit here is a port defect |
| **2. Wiring + the port tax** | DI decorators, and ~52 `throw new XxxException()` sites from `@nestjs/common` sitting *inside* domain code | **Strip decorators; replace the exception dependency (§3)** |
| **3. HTTP shell** | controllers, resolvers, guards, decorators, pipes, interceptors, filters, modules, `main.ts` | **Rewrite in the target framework (§4)** |

---

## 2. Layer 1 — the carry-over contract

Give this to every agent as a do-not-touch list. Name it explicitly; do not say "don't break
things".

```
KEEP EXACTLY AS-IS (do not edit, do not "improve", do not reformat):
  src/rbac-core/**                               (zero-dep by design)
  src/database/repositories/**                   (the 4 contracts + all 4 adapter families)
  src/database/migrations/**, schema.prisma, drizzle/schema.ts,
    sequelize/models/**, mongoose/schemas/**, seed/rbac.seed.json
  src/config/env.schema.ts                       (zod — framework-free; reuse it verbatim)
  The METHOD BODIES of: auth.service.ts, authz.service.ts, rbac-admin.service.ts,
    password.service.ts, and all 4 strategy classes
```

Verify the claim before trusting it, and re-verify after every wave:

```bash
grep -rln "@nestjs" src/rbac-core/ src/database/repositories/
# must print nothing, in every wave, forever
```

`STYLE.md` requires each strategy and repository folder to stay **deletable as a whole folder**.
That property is what makes this port cheap — protect it: a port that leaks Hono's `Context`
into `auth-strategies/` has destroyed the next port.

---

## 3. Layer 2 — the port tax, and the one real change to domain code

The honest part. Domain code **does** depend on Nest in two places:

### 3a. ~52 thrown HTTP exceptions

```
27 × UnauthorizedException     8 × NotFoundException     8 × ConflictException
 7 × ForbiddenException        2 × InternalServerErrorException
```

These come from `@nestjs/common` and live inside domain files:

```
src/auth-strategies/jwt-stateless/jwt-stateless.auth-strategy.ts
src/auth-strategies/jwt-stateless/refresh-token.service.ts
src/auth-strategies/session-redis/session-redis.auth-strategy.ts
src/modules/auth/auth.service.ts
src/modules/rbac-admin/rbac-admin.service.ts
```

A Hono app must not import `@nestjs/common`. Two honest resolutions — pick one and **write the
choice into every dispatch prompt**, or agents will each invent their own:

**Option A — a domain error shim (cheapest, lowest risk).** Create one file that defines
framework-free error classes with the same names and shape as Nest's (`status`, message), then
repoint those five imports at it. The shell maps `err.status → HTTP status` in one place. The
domain code's `throw` sites do not change at all — only the import path. ~5 files, ~1 agent,
near-zero regression risk. **Recommended for a first port.**

**Option B — a proper domain error type (cleaner, more work).** Replace throws with
`new AuthError('INVALID_CREDENTIALS')` etc. and map codes → statuses in the shell. Better
layering, but it edits 52 call sites *and* the specs that assert on exception types
(`auth.service.spec.ts` asserts `UnauthorizedException` with an exact message). Only worth it if
you intend to keep this port long-term.

Whichever you choose, one rule is non-negotiable: **the security-relevant messages and their
indistinguishability must survive.** `auth.service.ts` deliberately uses one
`INVALID_CREDENTIALS` string for absent user, wrong password, inactive account *and* lockout. A
port that maps these to four different messages has reintroduced account enumeration — the
exact defect class this codebase spent a wave eliminating.

### 3b. Other small couplings

| Coupling | Where | Replacement |
|---|---|---|
| `JwtService` (`@nestjs/jwt`) | `jwt-stateless/token.service.ts`, `jwt-stateless.auth-strategy.ts` | Use only `sign(claims, opts)`, `verify<T>(token, opts)`, `decode<T>(token)`. Swap to `jose` (edge-safe) or `jsonwebtoken` (Node-only) — ~40 lines in one file |
| `Logger` (`@nestjs/common`) | 13 sites | The target framework's logger, or `console` behind a 3-line interface |
| `ConfigService` | `src/config/app-config.service.ts` | Delete. Call `envSchema.parse(process.env)` once at boot and export the frozen object. **Keep the fail-fast behaviour** — the app must still refuse to boot on invalid secrets (`CONTRACTS.md` §9) |
| `OnModuleInit` | `login-attempt.service.ts` | Call the init function explicitly from your composition root |
| `@Inject(TOKEN)` constants | `src/common/constants.ts` | Keep the *values* (they document the seams); the symbols stop being DI tokens and become plain keys in your composition root |

---

## 4. Layer 3 — the shell rewrite, construct by construct

The heart of the port. Every row is a Nest idea and what it becomes.

| Nest construct | Where it lives now | What replaces it |
|---|---|---|
| `@Controller('auth')` / `@Post('login')` | `modules/*/**.controller.ts` | The framework's router — `app.post('/auth/login', h)` (Hono), `export async function POST(req)` (Next), `router.post('/login', h)` (Express), `.post('/auth/login', h)` (Elysia) |
| `@Injectable()` + constructor injection | all services | **A composition root** (§5). `new AuthService(users, roles, strategy, passwords, attempts)` |
| `@Module()` | 9 files (`app.module.ts`, the 4 strategy/config/database/graphql modules, the 2 feature modules, and `seed/rbac.seed.ts`) | Delete. Wiring becomes the composition root |
| `@Public()` | `common/decorators/public.decorator.ts` | A **public-paths set** the auth middleware consults — or simply mount public handlers *before* the auth middleware |
| `@Permissions('manage:User')` | `common/decorators/permissions.decorator.ts` | Pass the requirement explicitly: `withPermission('manage:User', handler)`, or per-route config |
| `@CurrentUser()` | `common/decorators/current-user.decorator.ts` | Read from request context — `c.get('user')` (Hono), `req.user` (Express), a `ctx` you thread yourself (Next) |
| `AuthGuard` / `RbacGuard` | `common/guards/` | Middleware or a higher-order handler wrapper. **Order is now your job — see §6** |
| `GraphqlThrottlerGuard` | `common/guards/` | Delete with GraphQL, or re-implement per transport |
| `ValidationPipe` + `class-validator` | `main.ts` + DTO decorators | **zod, already a dependency.** `schema.safeParse(await c.req.json())` → 400. The DTO *shapes* are frozen (`CONTRACTS.md` §6); only the decorators go |
| `LoggingInterceptor`, `TimeoutInterceptor`, `TransformInterceptor` | `common/interceptors/` | Response wrapper / logging middleware. `{ data, meta }` is a **client-visible contract** — `../client/src/lib/api.ts` unwraps it, so keep it or update the client |
| `HttpExceptionFilter` | `common/filters/` | The framework's error hook — `app.onError()` (Hono), a top-level try/catch (Next), error middleware (Express). Preserve the error-body shape: `{ statusCode, error, message, path, timestamp }` |
| `@nestjs/config` | `config/` | `envSchema.parse(process.env)` + a plain exported object |
| `@nestjs/throttler` + `@Throttle()` | `app.module.ts`, controllers | `express-rate-limit`, `hono-rate-limiter`, `@upstash/ratelimit` (serverless). **Preserve the per-route ceilings: register 3 / login 5 / refresh 5 per 60s** |
| `@nestjs/graphql` + Apollo | `graphql/`, `*.resolver.ts` | Optional. Drop it (delete resolvers + module) or use `graphql-yoga`. If you drop it, also delete the `context.getType<'graphql'>()` branches in the guards |
| `FastifyAdapter` / `main.ts` | `main.ts` | The framework's entrypoint and bootstrap |
| `@nestjs/testing` | all `*.spec.ts` | Vitest + the framework's test client. **See §7 — reuse assertions, rewrite harnesses** |

---

## 5. Replacing DI: the composition root

Nest's one genuinely valuable feature here is wiring. Replace it with **one file** that builds
everything explicitly and exports it. This is also where you make the strategy switches work.

```ts
// src/composition.ts — the whole "container", ~60 lines
import { envSchema } from './config/env.schema.js';
import { createAuthStrategy } from './auth-strategies/create-auth-strategy.js';
import { createAuthorizationProvider } from './rbac-strategies/create-authorization-provider.js';
import { createUserRepository /* … */ } from './database/create-repositories.js';

export function createContainer() {
  const config = envSchema.parse(process.env);          // fail-fast, as today
  const db = createDbClient(config);                     // DB_PROVIDER switch
  const users = createUserRepository(config, db);        // USER_REPOSITORY
  const strategy = createAuthStrategy(config, /* deps */); // AUTH_STRATEGY switch
  const authz = createAuthorizationProvider(config, /* deps */); // RBAC_STRATEGY switch
  const passwords = new PasswordService();
  const attempts = new LoginAttemptService(config);
  const auth = new AuthService(users, roles, strategy, passwords, attempts);
  const authzService = new AuthzService(authz);
  const rbacAdmin = new RbacAdminService(/* … */);
  return { config, auth, authzService, rbacAdmin, strategy, authz };
}

export const container = createContainer();
```

**The two factory functions already exist in spirit but are trapped in Nest modules.** Lift the
`switch` statements out of `auth-strategies.module.ts`, `rbac-strategies.module.ts` and
`database.module.ts` into plain factory modules. That preserves the "0-effort switch" property
(`plan.md` §3.2) — changing `AUTH_STRATEGY` must still swap the strategy with no other edit.

**Serverless warning.** If the target is Next.js / Workers / Lambda, a module-level singleton
that opens a Redis or Postgres connection at import time will break (cold starts, connection
exhaustion). `LoginAttemptService` opens its client in the constructor today. Hoist connections
into a lazily-memoised getter, and remember that under `Next.js` middleware the runtime is
**Edge** — no `ioredis`, no `pg`, no native `argon2` (§9c).

---

## 6. Security invariants — the part a port silently breaks

A port that compiles, boots and passes the happy path can still have removed the security
model. **Copy this list into every dispatch prompt** and verify each one explicitly:

1. **`AuthGuard` runs before `RbacGuard`.** In Nest this is enforced by argument order. As
   middleware it is *registration order* — now your responsibility, in a codebase where getting
   it wrong either denies everything or, if "fixed" by skipping the check, becomes an auth
   bypass. This is the single most likely way to ship a hole.
2. **`can()` is the sole deny-gate, and it denies by default.** `rbac-core/can.ts` returns
   `false` on malformed input. Do not "simplify" the ported wrapper into `if (permissions…)`.
3. **Every route is deny-by-default.** Nest applies guards globally via `APP_GUARD`; a
   router-based framework has no such default. Enumerate the public routes *explicitly* —
   `/auth/register`, `/auth/login`, `/auth/refresh` — and make everything else authenticated by
   construction, not by remembering to decorate it.
4. **One failure message for every login failure** (absent user / wrong password / inactive /
   lockout). And keep the **timing defence**: the absent-user path must still run a full argon2
   verification against `ABSENT_USER_HASH` before the null check.
5. **Timing-safe password comparison** — argon2 `verify`, never `===`.
6. **Refresh tokens: only the SHA-256 hash is stored; rotate on every use; reuse revokes the
   family.** This lives in the carried-over strategy code — verify it survived, do not re-invent.
7. **JWT verification pins `algorithms`, `issuer`, `audience`.** When swapping `@nestjs/jwt` to
   `jose`, re-check all three are still passed. Dropping `algorithms` is the classic mistake.
8. **Password/credential material never logged.** The current logging interceptor redacts; the
   ported logger must too.
9. **CSRF only when a cookie credential is active** (`session-redis`). A bearer-token API does
   not need it, and CSRF on a stateless API is a false sense of safety.
10. **Fail-fast boot on invalid secrets.** Keep `envSchema.parse` at startup; never fall back to
    a default key.
11. **Auto-logout / forced logout**: with `session-redis`, `logout` and deactivation work by
    deleting the Redis session key. Port the *behaviour*, and remember `PORT-EXPRESS.md`-class
    bugs hide here: the strategy resolves its own session ref from the request, which is
    framework-specific in exactly one place.

---

## 7. The acceptance test is already written — reuse it

`test/auth.e2e-spec.ts` (42 tests) is the port's definition of done. It:
- boots the **real** `AppModule` and drives **real HTTP**,
- runs the **same spec file twice**, once per `AUTH_STRATEGY`,
- substitutes only the persistence boundary (in-memory repositories in `test/support/`).

**Port procedure:**

1. Keep every `it(...)` and every assertion **byte-identical**. They are already
   framework-independent: they speak HTTP and the `{ data, meta }` envelope.
2. Rewrite only the **harness** — how the app is built (`createApp`) and how the credential is
   applied (`authorize()`, the one function that knows bearer-token vs cookie).
3. A test that fails is a **port defect**, not a test to adjust. That is the entire point of
   keeping them unchanged: the assertion set becomes an oracle that the rewrite cannot
   negotiate with.

Same principle for the unit specs: `rbac-core/can.spec.ts`, the strategy specs and the
repository specs test carried-over code, so they should pass **unmodified** — if one needs
editing, you changed something you should not have.

**Expected test deltas:** specs for deleted shell files disappear (`rbac.guard.spec.ts`,
`auth.guard.spec.ts`, `graphql-throttler.guard.spec.ts`, the interceptor/filter specs) and are
replaced by their framework equivalents. Unit count *will* drop; that is not a regression, but
each removed file must be replaced by a test at the new seam.

---

## 8. Wave plan for agents

Sequenced so that nothing parallel shares a file. Budget per `orchestrate-skill.md` §2b (~40–120k
per agent) and do the small waves yourself (§6a).

**Wave 0 — orchestrator, no agents.** Establish the seam. Pick Option A or B from §3a. Lift the
three `switch` factories out of the Nest modules into plain factories. Write `src/composition.ts`
and get it constructing every object and running `envSchema.parse` — with **no HTTP layer yet**.
Freeze it. *Gate: a scratch script constructs the container and calls `auth.login()` directly
against in-memory repositories, no framework involved.* This wave is the whole port's risk; do
not parallelise it.

**Wave 1 — carry-over verification, one agent or none.** Run the unit specs for `rbac-core` and
the four strategies against the new container. Expect zero edits. If edits are needed, stop and
find out why before writing any routing.

**Wave 2 — two verticals in parallel, no shared files:**
- **`auth-vertical-agent`** — `POST /auth/register|login|refresh|logout`, `GET /auth/me`,
  `POST /authz/check`. Owns its route files + wiring only.
- **`rbac-admin-vertical-agent`** — the 9 `/rbac-admin/*` routes. Owns its route files + wiring
  only.

Both consume the frozen container from Wave 0 and must not edit it. Neither writes middleware.

**Wave 3 — cross-cutting, after both verticals land (sequential, 1–2 agents):**
- auth/authorization middleware (`AuthGuard` → `RbacGuard` equivalent) — **the ordering rule in
  §6.1**
- input validation (zod schemas replacing the DTO decorators)
- the error handler preserving the error-body shape
- the `{ data, meta }` response envelope
- per-route rate limits
- logging with redaction

This wave cannot run before the verticals, because it wraps their handlers.

**Wave 4 — orchestrator.** Port the e2e harness (§7), run the gate (§10), commit.

---

## 9. Framework-specific notes

### 9a. Express without Nest
The simplest target. `app.use(authMiddleware)` then `app.use(rbacMiddleware)` — order is visually
explicit, which makes §6.1 easy. Use `express-rate-limit`. **Check your Express major before
wiring the error handler:** Express 4 does *not* forward a rejected promise from an async
handler to error middleware, so every `async` route needs a wrapper (or `express-async-errors`);
Express 5 does forward it. `@nestjs/platform-express` pins Express transitively, so confirm the
resolved version rather than assuming. Getting this wrong means an async auth failure becomes a
hung request instead of a 401.

### 9b. Hono
Closest conceptual fit — `c.set('user', u)` / `c.get('user')` replaces `@CurrentUser()`, and
`app.onError()` replaces the exception filter cleanly. `middleware` chains in registration order,
so §6.1 maps directly. Runs on Node, Bun, Deno, Workers. Use `hono-rate-limiter`. If deploying
to Workers, you are on the edge runtime — see §9c.

### 9c. Next.js App Router — the sharpest edges
- **Middleware runs on the Edge runtime.** No `ioredis`, no `pg`, no native `argon2`. So the
  auth *logic* must live in Route Handlers (`app/auth/login/route.ts`) which can opt into the
  Node runtime; middleware should do at most cheap JWT verification with an edge-safe library.
- **Use `jose`, not `jsonwebtoken`** if any verification happens in middleware.
- **No long-lived process.** A Redis/Postgres client opened at module scope leaks connections
  across serverless invocations; memoise lazily and pin `globalThis` in dev.
- **No global guard.** Next has no `APP_GUARD` equivalent — deny-by-default must be enforced by
  a helper every handler calls, or by a middleware matcher config. Getting this wrong is how
  Next ports ship unauthenticated endpoints; write the public-route list down explicitly (§6.3).
- Route Handlers receive a standard `Request`/`Response` — `transform.interceptor.ts`'s envelope
  becomes an explicit `NextResponse.json({ data, meta })`.

### 9d. Elysia / Bun, Deno, others
Same shape as Hono: explicit router, per-route guards, one error hook. Bun has native
`Bun.password` (argon2) which can replace the `argon2` package — but if you swap it, re-run the
timing-safety and hash-format checks, because existing hashes in the database are argon2id
strings and must still verify.

### 9e. Anything not listed
The checklist that generalises: does it have (1) an explicit router? (2) middleware or a
handler wrapper with deterministic order? (3) an error hook? (4) request-scoped context for the
user? (5) a rate limiter? If all five, §4's table maps 1:1. If it lacks a rate limiter, that is
a **security gap to close explicitly**, not a feature to skip — per-IP throttling on
`login`/`register`/`refresh` is spec §6.

---

## 10. Acceptance gate

Nothing is "ported" until all of these hold:

1. `pnpm build` exit 0 · `tsc --noEmit` exit 0 · lint exit 0.
2. **Carried-over unit specs pass unmodified** — `rbac-core/can.spec.ts` and the four strategy
   specs. Any edit to them is a red flag to investigate.
3. **The e2e suite passes with assertions byte-identical** (§7), 42 tests, both
   `AUTH_STRATEGY` values. Harness changes only.
4. `grep -rln "@nestjs" src/rbac-core/ src/database/repositories/` → **empty**.
5. `grep -rn "<oldFramework>" src/auth-strategies/ src/rbac-strategies/` → **empty** (the
   deletable-folder property survived).
6. **Real requests against the running app**, not just a boot:
   - unauthenticated `GET /auth/me` → 401 in the standard error shape
   - `GET /rbac-admin/roles` as a plain user → **403** (proves the authorization middleware
     actually runs, not just the auth one)
   - a login-failure loop → **429** at the configured ceiling
   - two distinct client IPs → two distinct throttle buckets
   - invalid body → 400
7. Every invariant in §6 checked off explicitly, one line of evidence each.
8. Docs updated: `MEMORY.md` (decisions + why), `WAVE-LOG.md` (ledger + gate results),
   `README.md` (stack, scripts, layout), `CONTRACTS.md` (change-log row for §3a's choice),
   `STYLE.md` (the port's own binding rules).

---

## 11. Anti-patterns that sink ports

| Anti-pattern | Why it is fatal |
|---|---|
| Rewriting `rbac-core` or a repository "to fit the framework" | The whole port's value is that these didn't change. If they must, the layering was already broken |
| Letting the framework's request type leak into `auth-strategies/` | Destroys the deletable-folder property and every future port |
| Reimplementing `can()` in the new shell | A second source of truth for authorization. Call the carried-over function |
| Enforcing deny-by-default by remembering to add middleware per route | One forgotten route is an open endpoint. Enumerate the *public* ones instead |
| Porting the tests by weakening them until they pass | The unmodified assertions are the only objective proof the port is faithful |
| Replacing `@nestjs/jwt` while dropping `algorithms`/`issuer`/`audience` | Turns verification into "decode and trust" |
| Assuming green build + boot means working | Wave 7 lost three runtime crashes that every static check passed. Execute real requests |
| Porting GraphQL by default | It is optional surface. Dropping it (and its guard branches) is often correct |
| Doing the whole port in one agent | The container seam (Wave 0) is the risk; parallelising before it is frozen guarantees rework |
