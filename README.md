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
| `pnpm test` | Unit suite (vitest, 13 files / 96 tests) |
| `pnpm test:e2e` | End-to-end suite |
| `pnpm lint` | oxlint |

## Companion client

`../client/` is a Next.js + shadcn testing UI for this service (auth flow lab,
session inspector, RBAC admin console). It only calls the REST API — point it
here with `NEXT_PUBLIC_API_URL=http://localhost:<PORT>`.

## Known limitations

- `session-redis` is experimental: logout no-ops and the cookie isn't attached
  on all paths (open items S1/S2). Default pairing
  (`jwt-stateless` + `embedded-claims`) is the stable path.
- GraphQL `variables` are rejected on input-typed args — inline literals in
  queries (open item S13).
- No `GET /auth/me` yet; the session's user object comes back with every
  auth response instead.
- `deletePermission` doesn't fan out cache invalidation under `db-live`
  (up to 5s stale, open item S9).

## Continuing the agent-built waves

This repo was built in orchestrated waves (7 of 8 done). To resume that
process, read `.agents/plan/orchestrate-skill.md` first, then `MEMORY.md`
(build log + checkpoint) and `WAVE-LOG.md` (ledger + open security items
S1–S15). Wave 8 (remaining): e2e coverage, `/auth/me` + `/authz/check`,
React `usePermission()`, `auth.guard.spec.ts`.
