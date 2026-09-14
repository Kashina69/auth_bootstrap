# auth — NestJS Auth + RBAC Service

A drop-in, database-backed **authentication + RBAC (role-based access control)**
service built with **NestJS 12 on Fastify**. It exposes every operation over
**both REST and GraphQL** (same rules, same service methods — neither transport
can drift from the other), and its auth mechanism, authorization source, and
database layer are all **pluggable strategies** picked via environment variables.
No code changes needed to switch from JWTs to Redis sessions, from cached claims
to live DB lookups, or from Postgres/Prisma to Mongo/Mongoose.

## What it does

- **Auth flows** — `register`, `login`, `refresh` (rotating, single-use refresh
  tokens with reuse detection), `logout`. Passwords are `argon2id`-hashed with
  timing-attack-safe verification; failed logins get one generic error message
  so accounts can't be enumerated.
- **RBAC** — roles, permissions (`action:subject`, e.g. `manage:User`), grants,
  and user-role assignment, seeded from one JSON file (`src/database/seed/`)
  and editable at runtime through the admin API. Framework-free `can()` /
  `hasRole()` core plus `@Permissions()` / `@Roles()` guards.
- **Security defaults** — helmet headers, per-route rate limits, global input
  validation, response envelope, GraphQL depth/complexity limits, CORS
  deny-all unless explicitly configured, fail-fast env validation (the app
  refuses to boot on bad config).

## Strategy matrix (all env-selected, zero code changes)

| Concern | Option A (default) | Option B |
|---|---|---|
| Session | `jwt-stateless` — signed access token (15m) + rotating refresh token (30d), `Bearer` header, no server state | `session-redis` — server-side session in Redis, httpOnly `sid` cookie (experimental, see below) |
| Authorization | `embedded-claims` — roles/permissions baked into the token, zero DB hits, changes apply on refresh | `db-live` — resolved live per request (5s Redis cache + instant invalidation on admin changes) |
| Database | `prisma` (Postgres) | `drizzle`, `sequelize` (Postgres) or `mongoose` (Mongo) |

## Quick start

See **[setup.md](./setup.md)** for the full guide (Docker Postgres/Redis,
migrations, seed, first login). Short version:

```bash
cp .example.env .env
# start Postgres, apply src/database/migrations/*.sql, then:
pnpm install
pnpm seed:rbac
pnpm start:dev
```

Every variable is documented in **`.example.env`** — copy it and you get a
working local config.

## API surface

REST (all responses wrapped in `{ data, meta }`):

| Method & path | Auth | Description |
|---|---|---|
| `POST /auth/register` | public | Create account, gets default `user` role |
| `POST /auth/login` | public | Returns user + token pair |
| `POST /auth/refresh` | public | Rotates the token pair |
| `POST /auth/logout` | Bearer | Revokes session |
| `GET /auth/me` | Bearer | Caller's identity + roles/permissions, resolved through the active RBAC strategy |
| `POST /authz/check` | Bearer | `{ action, subject }` → `{ allowed }` — the same `can()` the guard uses |
| `GET /rbac-admin/roles` | `manage:User` | List all roles |
| `POST /rbac-admin/roles` | `manage:User` | Create role |
| `DELETE /rbac-admin/roles/:id` | `manage:User` | Delete custom role (system roles protected) |
| `GET /rbac-admin/roles/:id/permissions` | `manage:User` | Grants of one role |
| `POST /rbac-admin/roles/:id/permissions` | `manage:User` | Attach permissions **by name** |
| `DELETE /rbac-admin/roles/:id/permissions` | `manage:User` | Detach permissions **by name** |
| `GET /rbac-admin/permissions` | `manage:User` | List all permissions |
| `DELETE /rbac-admin/permissions/:id` | `manage:User` | Delete custom permission |
| `POST /rbac-admin/users/:userId/roles` | `manage:User` | Assign role to user |
| `POST /graphql` | mixed | Mirror of all of the above (dev playground) |

Passwords must contain a lowercase, uppercase, digit, and symbol character.

## Configuration

All knobs live in `.env` and are validated at boot — see [`.example.env`](./.example.env)
for every variable, its possible values, and when to use each. Highlights:
`NODE_ENV`, `PORT` (default 3000), `AUTH_STRATEGY`, `RBAC_STRATEGY`,
`DB_PROVIDER`, `DATABASE_URL`, `JWT_ALGORITHM` + keys/secret, `REDIS_URL`
(required for `session-redis` / `db-live`), `CORS_ORIGINS`.

## Layout

```
src/
  modules/auth/        login/register/refresh/logout (controller + resolver + service)
  modules/rbac-admin/  runtime role/permission CRUD (controller + resolver + service)
  auth-strategies/     jwt-stateless | session-redis (frozen IAuthStrategy)
  rbac-strategies/     embedded-claims | db-live (frozen IAuthorizationProvider)
  rbac-core/           framework-free can()/hasRole()/hasAnyPermission()
  database/            schema + raw-SQL migrations + seed + 4 ORM adapters
  common/              guards, decorators, filters, interceptors, argon2/lockout
  config/              zod-validated env (env.schema.ts) + typed AppConfig
  graphql/             Apollo code-first bootstrap (+ generated schema.gql)
```

## Scripts

| Command | Purpose |
|---|---|
| `pnpm start:dev` | Watch-mode dev server |
| `pnpm build` / `pnpm start` | Production build / run |
| `pnpm seed:rbac` | Idempotent baseline seed (3 roles, 8 permissions) |
| `pnpm test` | Unit suite (29 files / 259 tests) |
| `pnpm test:contract` | Adapter contract suite — one shared contract run against **all four** ORMs (4 files / 108 tests). Needs `pnpm test:services:up`. |
| `pnpm test:integration` | Live-service suite — real Redis + real Postgres (6 files / 46 tests + 2 quarantined). Needs `pnpm test:services:up`. |
| `pnpm test:e2e` | End-to-end suite — REST **and** GraphQL, the same spec files run once per `AUTH_STRATEGY` (82 tests + 2 quarantined) |
| `pnpm test:smoke` | Boot smoke — boots the real `AppModule` over real Postgres/Redis and asserts on live HTTP responses. Needs `pnpm test:services:up`. |
| `pnpm test:cov` | Unit suite with coverage; enforces the per-directory thresholds in `vitest.coverage.ts` |
| `pnpm test:services:up` / `down` | Start / stop the Docker stack the contract + integration suites need (Postgres 55432, Redis 56379, Mongo 57017) |
| `pnpm test:all` | Every suite in sequence |
| `pnpm lint` | oxlint |

## Known limitations

- `session-redis` is experimental: **the session cookie is never attached** on
  any path, so cookie-only refresh does not work (open item S2). Its `logout`
  was fixed in Wave 8. Default pairing (`jwt-stateless` + `embedded-claims`)
  is the stable path.
- GraphQL `variables` never reach the server on POST — inline literals in
  queries. Measured in Wave 8: the query arrives, the `variables` map does not,
  and the schema is not at fault (open item S13).
- The Next.js client is bearer-only (`api.ts` never sets
  `credentials: 'include'`), so it cannot use the `session-redis` cookie
  transport.
- ~~The e2e suite replicates `main.ts`'s global setup by hand.~~ **Fixed (Wave 9):** both now
  call `configureApp()` from `src/configure-app.ts`, so a new global enhancer is covered by the
  e2e suite the moment it is added. This also brought the `session-redis` CSRF registration
  under test for the first time.
- **`DB_PROVIDER=drizzle` could not insert against the migrated schema.** *(Wave 9 finding,
  fixed in Wave 10.)* The migrations declared no column default on any `id` or on
  `users/roles.updated_at`, and Drizzle emits `DEFAULT` for both — so every insert died on a
  not-null violation. They were also `TIMESTAMP(3)` without a zone while Drizzle and Sequelize
  both declare `timestamptz`, and node-pg parses a zoneless timestamp as *local* time, shifting
  the instant on any non-UTC host. Migration
  `20260914000001_timestamptz_and_column_defaults` adds the DB-side defaults and moves every
  timestamp to `TIMESTAMPTZ(3)`; `schema.prisma` is annotated to match. **The test-time schema
  patch that used to hide this is deleted** — the contract suite now runs against the schema
  that ships.
- **`refresh` used to answer a dead Redis with a 500** while every other guarded route answered
  a clean 401. *Fixed in Wave 10* — both paths now fail closed identically (S19).
- **A soft-deleted account still reserves its email** (S20), and **deactivating an account does
  not revoke its live session** (S21). Both are pinned by tests and open deliberately: each fix
  is a product decision (should an address become reusable after deletion; should a
  deactivation revoke sessions and at what cost) rather than a bug to patch.
- `app.close()` now releases its connections (`DatabaseLifecycle`, `RedisClientLifecycle`,
  `LoginAttemptService.onModuleDestroy`). Before Wave 10 it released nothing, so the process
  never exited after shutdown — the boot smoke script needed a forced `process.exit`, which is
  now gone.
- `deletePermission` doesn't fan out cache invalidation under `db-live`
  (up to 5s stale, open item S9).

## Current state + how to resume

**All 8 build waves and all 13 phases of the plan are complete.** The test suite was then built
out per `TEST-PLAN.md` (Wave 9), and the defects it found were fixed (Wave 10). Gate at HEAD:

```
pnpm build                               0
pnpm exec tsc --noEmit -p tsconfig.json  0
pnpm exec oxlint src/ test/              0
pnpm test                                29 files / 259 passed
pnpm test:contract                        4 files / 108 passed
pnpm test:integration                     6 files /  46 passed  (+2 quarantined)
pnpm test:e2e                             2 files /  82 passed  (+2 quarantined)
pnpm test:smoke                           16/16, exits unaided
pnpm test:cov                             0 — per-directory thresholds met
```

Plus 4 deliberately quarantined tests (`it.fails`) tracking S2, S13, S20 and S21 — each written
against the *intended* behaviour so it flips green when fixed. A quarantine that fails loudly is
a tracked hole, not a pass.

Before Wave 9, `DB_PROVIDER=drizzle|sequelize|mongoose` and the GraphQL surface were never
executed by any test. They are now — and doing so surfaced real defects: the Drizzle adapter
could not insert at all, timestamps were zoneless, `refresh` mishandled a Redis outage, and
nothing released connections on shutdown. All four are fixed. See `WAVE-LOG.md` Waves 9–10.

Everything a resuming chat needs is in **`.agents/plan/`** — read them in this order:

| File | What it is | Read it when |
|---|---|---|
| `orchestrate-skill.md` | **How to run this build with subagents** — §2 is the dispatch decision (whether to spawn an agent at all, how wide to scope it, how to make parallel work safe), then the prompt template, the gate, verification tiers and the anti-pattern table | first, if you intend to dispatch agents |
| `MEMORY.md` | Build log: every decision + rationale, and the end-of-wave checkpoint | to learn *why* anything is the way it is |
| `CONTRACTS.md` | The frozen interfaces (§1–§10) and the `modules/auth/` surface (§11). **Workers never edit this** | before writing code against any interface |
| `WAVE-LOG.md` | Per-wave ledger: agents, token cost, gate results, defects, and open items S1–S15 with severity | to pick up a known defect |
| `plan.md` / `implementation.spec.md` | The architecture and the security-critical code spec | for the original intent |
| `plan.agent.md` | The original wave schedule (Waves 1–8) | historic reference only — it is done |
| `STYLE.md` | The binding code-style contract | paste into every agent prompt |
| `PORT-EXPRESS.md` | Swapping the HTTP adapter to Express, staying on NestJS | to move to NestJS + Express |
| `PORT-FRAMEWORK.md` | Leaving NestJS for Hono, Next.js, Elysia, bare Express… | to port the whole stack to another framework |

**There is no next wave to dispatch.** Future work is *remediation and extension*, not the
original build — start from the open-items table in `WAVE-LOG.md` (S2 is the highest-severity
one still open) rather than from `plan.agent.md`.

### Companion client

`../client/` is a Next.js + shadcn testing UI for this service (auth flow lab, session
inspector, RBAC admin console). Point it here with
`NEXT_PUBLIC_API_URL=http://localhost:<PORT>`.
