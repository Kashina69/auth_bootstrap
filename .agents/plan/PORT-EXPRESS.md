# PORT-EXPRESS.md — Porting this service from Fastify to Express

**Scope:** stays on NestJS. Swaps the HTTP adapter and the three `@fastify/*` plugins for their
Express equivalents. This is the *small* port — a surgical transport swap.

**If the target is NOT NestJS** (Hono, Next.js route handlers, Elysia, bare Express without
Nest…), stop and use `PORT-FRAMEWORK.md` instead. That is a different job: the framework's DI,
guards, pipes and decorators all disappear, and this file will mislead you.

**Prerequisites:** read `orchestrate-skill.md` (how to dispatch agents), `CONTRACTS.md` (frozen
interfaces you must not break) and `STYLE.md` (paste into every agent prompt). This file assumes
you are the orchestrator running the wave plan in §7.

---

## 1. What actually changes (and what does not)

Verified by grep against HEAD, not assumed:

| Layer | Nest coupling | Port effort |
|---|---|---|
| `src/rbac-core/` (5 files) | **zero** `@nestjs` imports | **nothing** |
| `src/database/repositories/*` + all 4 adapter families | **zero** `@nestjs` imports | **nothing** |
| `src/database/` schema, migrations, models, seed JSON | none (seed *script* has a Nest import) | **nothing** |
| 4 strategy classes (`jwt-stateless`, `session-redis`, `embedded-claims`, `db-live`) | **zero Nest decorators — plain classes** | **nothing** |
| `src/modules/*/…service.ts` | `@Injectable()`/`@Inject()` decorators only | **nothing** — decorators stay, Nest is retained |
| `src/common/guards`, `decorators`, `filters`, `interceptors` | `ExecutionContext`, `CallHandler`, `ArgumentsHost` | **untouched** — these are Nest abstractions, adapter-independent |
| `src/main.ts` | `FastifyAdapter`, `@fastify/helmet`, `@fastify/cors`, `@fastify/csrf-protection` | **rewrite (~80 lines)** |
| `src/common/filters/http-exception.filter.ts` | `FastifyReply.code().send()` | **one line** |
| Files typing `FastifyRequest` | 6 files (see §3) | **type-only, mostly** |
| GraphQL driver | needs `@as-integrations/express5` | **one dependency + config** |

**The headline:** because every guard, pipe, interceptor and filter in this codebase is written
against Nest's *platform-agnostic* abstractions, almost none of them care which HTTP adapter is
underneath. The port is concentrated in `main.ts` plus a handful of type annotations.

---

## 2. The blockers, in the order they will bite you

### 2a. GraphQL: `@as-integrations/express5` is not installed — **this one is proven**

Not a theory. The (since-deleted) `test/app.e2e-spec.ts` booted `AppModule` with the **default
Express adapter** — `createNestApplication()` with no `FastifyAdapter`. Result:

```
[PackageLoader] The "@as-integrations/express5" package is missing. Please, make sure to
install it to use GraphQLModule.
Error: process.exit unexpectedly called with "1"
  at ApolloDriver.registerExpress (…/apollo-base.driver.js:102:39)
```

The process died before a single assertion ran. So:

```bash
pnpm add @as-integrations/express5
```

and confirm a real Express boot maps `/graphql` before touching anything else. Note this is the
**mirror image** of the Fastify case recorded in `MEMORY.md` (Wave 6), where
`@as-integrations/fastify` was equally mandatory and equally non-obvious — the Apollo driver
`loadPackage()`s its integration at startup and hard-exits when it is absent.

If GraphQL is not required, you may instead remove `GraphqlModule` from `src/app.module.ts` and
skip this entirely — but then also delete the GraphQL branches in the guards, or they become
dead code that `tsc` will not flag.

### 2b. `main.ts` — the plugin swap

| Fastify (current) | Express equivalent | Notes |
|---|---|---|
| `new FastifyAdapter()` | *(omit)* — Nest defaults to Express when `@nestjs/platform-express` is present | it already is, in `package.json`, currently unused |
| `@fastify/helmet` via `app.register()` | `app.use(helmet())` | `helmet` is the same package family |
| `@fastify/cors` via `app.register()` | `app.enableCors({...})` | **see the trap below** |
| `@fastify/csrf-protection` | `csrf-csrf` or `csurf` middleware | only active under `session-redis` |
| `await app.listen(port, '0.0.0.0')` | unchanged | |

**The `app.enableCors()` trap, inverted.** `MEMORY.md` records that `app.enableCors()`
typechecks but *crashes at boot* here, because `skipLibCheck` hides an unresolvable import
inside `@nestjs/platform-fastify`. That is a **Fastify-adapter** problem. On Express,
`app.enableCors()` is the intended Nest path and should work — but do not assume it: boot it and
send a real preflight (§8). The `methods` array the current code passes explicitly
(`GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS`) must be preserved, or browser clients silently
lose all DELETE routes (detach permissions, delete role/permission).

### 2c. `src/common/filters/http-exception.filter.ts:30` — one line

```ts
response.code(status).send(buildErrorResponse(...));   // Fastify
response.status(status).send(buildErrorResponse(...)); // Express
```

Express's `Response` has no `.code()`. This is on the critical error path, so a typo here turns
every failure into an unhandled exception — and the existing spec
(`http-exception.filter.spec.ts`) fakes the reply, so **it will not catch this**. Prove it with a
real request that 4xx's (§8).

### 2d. `req.ip` and client IPs — a correctness issue, not a cosmetic one

`requestMeta()` in `src/modules/auth/auth.controller.ts` and `auth.resolver.ts` reads
`request.ip`. Under Express, `req.ip` is the **socket address** unless `trust proxy` is set — so
behind a load balancer every request reports the proxy's IP. That silently collapses the
per-IP throttler (register 3 / login 5 per 60s) into one shared bucket, which is both a
brute-force weakness and a self-inflicted outage. Set it deliberately:

```ts
app.set('trust proxy', <hops or a specific proxy CIDR>);  // never `true` blindly
```

Do not set `true` without knowing your topology — it lets a client forge `X-Forwarded-For` and
defeat the throttle entirely.

---

## 3. Type annotations — the mechanical pass

`FastifyRequest` / `FastifyReply` appear in **9 source files** (plus `main.ts`, three specs and
the e2e harness, which are handled separately in §7/§8):

```
src/auth-strategies/auth-strategy.interface.ts        ← FROZEN CONTRACT, see §4
src/auth-strategies/jwt-stateless/jwt-stateless.auth-strategy.ts
src/auth-strategies/session-redis/session-cookie.ts
src/auth-strategies/session-redis/session-redis.auth-strategy.ts
src/common/filters/http-exception.filter.ts
src/common/interceptors/logging.interceptor.ts
src/common/interceptors/transform.interceptor.ts
src/modules/auth/auth.controller.ts
src/modules/auth/auth.resolver.ts
```

Most are satisfied by Express's `Request`/`Response` (both have `.headers`, `.url`, `.ip`,
`.method`). Two need real thought:

- **`src/auth-strategies/session-redis/session-cookie.ts`** — `readSessionId(req)` parses
  `req.headers.cookie` by hand (deliberately: the folder must stay self-contained and
  `@fastify/cookie` is not a dependency). That logic is adapter-independent; only the parameter
  type changes.
- **`readBearerToken(req.headers.authorization)`** in the jwt-stateless strategy — same story,
  header-based and portable.

**Prefer a structural type over `express.Request`.** Defining a minimal local interface
(`{ headers: …; ip: string; url: string }`) keeps `auth-strategies/` free of *any* HTTP
framework's types, preserving the deletable-folder property `STYLE.md` mandates. This is the
change that makes §4 cheap.

---

## 4. The one frozen contract you must handle carefully

`src/auth-strategies/auth-strategy.interface.ts:29`:

```ts
validateRequest(req: FastifyRequest): Promise<AuthenticatedUser | null>;
```

This is **CONTRACTS.md §3 — frozen**. A worker must not edit it unilaterally. The orchestrator
freezes the new signature *before* dispatching, adds a change-log row, and only then does the
implementation.

Recommended replacement — the structural type from §3, which is adapter-agnostic and therefore
survives *this* port and any future one:

```ts
/** The minimum a strategy needs to read its own credential. Deliberately not a framework type. */
export interface CredentialRequest {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  url: string;
}
validateRequest(req: CredentialRequest): Promise<AuthenticatedUser | null>;
```

Touch list for that one change: the interface, both strategies, `AuthGuard`, and the specs for
`jwt-stateless`, `session-redis` and `auth.guard`. Budget it as its own wave (§7, Wave 1) — it is
the only change that crosses agent boundaries, so it must be frozen and merged before anything
parallel runs.

---

## 5. What must NOT change

Copy this into every dispatch prompt as a do-not-touch list:

- `src/rbac-core/**` — zero-dependency, framework-free. Any edit here is a bug in the port.
- `src/database/repositories/**` and all four adapter families — likewise Nest-free.
- The **security invariants** in `CONTRACTS.md` §9: argon2id; JWT verify pins
  `algorithms`/`issuer`/`audience`; refresh tokens stored only as SHA-256; identical login
  failure message; `can()` default-deny; **`AuthGuard` before `RbacGuard`**; CSRF only when
  cookie sessions are active; refuse to boot on invalid secrets.
- The **guard order** `@UseGuards(AuthGuard, RbacGuard)` — it is not stylistic. `RbacGuard`
  reads `request.user`, which only `AuthGuard` sets. Express middleware runs in registration
  order, so if you convert guards to middleware, that ordering becomes *your* responsibility in
  a way it was not before. This is the single most likely way to ship a silent auth bypass.

---

## 6. Working method for the mechanical pass

Do this **before** dispatching agents (§ `orchestrate-skill.md` §3):

```bash
grep -rn "Fastify" src/ test/ | grep -v node_modules   # the authoritative work list
grep -rln "@nestjs" src/database/ src/rbac-core/       # must print NOTHING — if it does, stop
pnpm build && pnpm test && pnpm test:e2e               # record the baseline first
```

---

## 7. Wave plan for agents

Small enough that you may well do Waves 1–2 yourself (`orchestrate-skill.md` §6a: if you can
name every file you will edit right now, dispatch nobody).

**Wave 1 — freeze + spine (orchestrator only, no agents).** Freeze the `validateRequest`
signature (§4), add the CONTRACTS change-log row, install `@as-integrations/express5`, and get a
bare Express boot mapping `/graphql`. Nothing parallel can start until this is green.
*Gate: `node dist/main.js` boots on Express and logs `Mapped {/graphql, POST}`.*

**Wave 2 — two agents, genuinely independent:**

- **`express-http-agent`** — owns `src/main.ts`, `src/common/filters/http-exception.filter.ts`.
  Swaps the adapter and the three plugins, adds the `trust proxy` decision, fixes `.code()` →
  `.status()`. **Do not touch anything under `src/auth-strategies/`.**
- **`express-types-agent`** — owns the 6 non-frozen files in §3 that type `FastifyRequest`, plus
  introduces `CredentialRequest`. **Do not touch `main.ts` or the filter.**

They share no file. Both must be given §5's do-not-touch list verbatim.

**Wave 3 — orchestrator gate, then a verifier.** Run §8. Then one diff-scoped adversarial
verifier (`MEMORY.md` shows this class of port is exactly where a code-reading review misses
things). Ask it specifically: *did the guard order survive, is `trust proxy` set to something
justifiable, and does `req.ip` still produce a per-client throttler bucket?*

---

## 8. Acceptance gate — port-specific

The standard gate (`orchestrate-skill.md` §7) plus these, because the standard gate **cannot**
see adapter regressions — the unit specs fake their request/reply objects:

1. `pnpm build` 0 · `pnpm test` 17 files / **142 passed** · `tsc --noEmit` 0 · `oxlint` 0.
2. `pnpm test:e2e` **42 passed**. This is the real prize: the suite boots the actual
   `AppModule` and drives real HTTP, so it exercises the adapter. Its harness may need
   `createApp` updated for Express — **change only the harness, never an assertion.** Every
   assertion in that file is adapter-independent by construction, so a failing one is a real
   port defect.
3. Boot the app and make **real requests** — a boot proves DI resolves, not that anything works
   (`orchestrate-skill.md` §7):
   - `GET /auth/me` unauthenticated → **401** with the standard error envelope (proves §2c).
   - `POST /authz/check` unauthenticated → **401**.
   - a **CORS preflight** (`OPTIONS` with `Origin` + `Access-Control-Request-Method: DELETE`) →
     `DELETE` still in `Access-Control-Allow-Methods` (proves §2b).
   - **throttling produces two distinct buckets** from two distinct client IPs, and a
     throttled response is **429** (proves §2d). This is the security-critical one.
4. `git status --short` — no agent wrote outside its owned paths.

---

## 9. Known traps, collected

| Trap | Why it bites |
|---|---|
| Apollo driver `loadPackage`s its integration at startup and `process.exit(1)`s when absent | §2a. It is not a normal missing-dep error; it kills the process during `app.init()` |
| `response.code()` | Fastify-only. The existing filter spec fakes the reply, so it stays green while production 500s |
| `req.ip` without `trust proxy` | Collapses every client into one throttle bucket. `trust proxy: true` is worse — forgeable `X-Forwarded-For` |
| Guard order becoming registration order | Express middleware order is manual. Reversing it means `RbacGuard` sees no `user` and **denies everything** — or, worse, a rewrite that "fixes" that by skipping the check becomes an auth bypass |
| `app.enableCors()` | Nest's own method; fine on Express, fatal on this repo's Fastify setup. Do not copy the Fastify workaround (`@fastify/cors` directly) into the Express path |
| Deleting the deleted scaffold e2e's lesson | It was unrunnable *because* it mixed adapters. If you write a new e2e helper, boot with the same adapter `main.ts` uses |

## 10. After the port

Update `MEMORY.md` (what changed + why + the `validateRequest` signature change), `WAVE-LOG.md`
(the ledger entry), `CONTRACTS.md` (the change-log row, if §4 was applied), `README.md`
(Fastify → Express in the intro, layout and stack), and `orchestrate-skill.md` if you learned a
dispatch lesson worth keeping. Commit with the attribution line the session specifies.
