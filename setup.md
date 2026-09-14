# Setup Guide — auth service

Gets the backend running from a fresh clone. Total: ~10 minutes, mostly
waiting on Docker pulls. If you'd rather have an AI do this with you
interactively, hand it [`setup_agent.md`](./setup_agent.md) instead.

## Prerequisites

- **Node 20+** and **pnpm** (`npm i -g pnpm` or `corepack enable`)
- **Docker** (recommended — Postgres and Redis run as containers, nothing
  installs on your machine), *or* your own Postgres 14+ / MongoDB / Redis

## 1. Install dependencies

```bash
cd auth
pnpm install
```

## 2. Configure environment

```bash
cp .example.env .env
```

Open `.env`. For a first run you only need to confirm these (defaults work):

| Variable | First-run value | Why |
|---|---|---|
| `NODE_ENV` | `development` | Enables GraphQL playground |
| `PORT` | `3000` (or free port) | Must not clash with your frontend dev server. The `.env` value is honored (it's schema-validated); a shell `PORT=` prefix overrides it per-run |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/auth` | Matches the Docker command below |
| `JWT_ALGORITHM` / `JWT_SECRET` | `HS256` + dev secret from template | Zero-key auth for local dev |
| `CORS_ORIGINS` | Your frontend origin, e.g. `http://localhost:3001` | Unset = browser clients blocked |

Everything else is documented inline in `.example.env`. The app validates
this file at boot and **refuses to start** on anything invalid — read the
error, it names the exact variable.

## 3. Database

**Option A — Docker Postgres (recommended):**

```bash
docker run -d --name auth-postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=auth -p 5432:5432 postgres:16
```

**Option B — your own Postgres:** create database `auth` and set
`DATABASE_URL` accordingly. (MongoDB users: set `DB_PROVIDER=mongoose` and a
`mongodb://` URL — migrations below don't apply, Mongoose manages its own
schema.)

Apply the migrations **in order** (raw SQL — the repo has no migrate runner):

```bash
docker exec -i auth-postgres psql -U postgres -d auth -v ON_ERROR_STOP=1 \
  -f - < src/database/migrations/20260911000000_init/migration.sql
docker exec -i auth-postgres psql -U postgres -d auth -v ON_ERROR_STOP=1 \
  -f - < src/database/migrations/20260914000000_permission_is_system/migration.sql
```

(With a local `psql`: `psql $DATABASE_URL -f <file>` for each file, in order.)

Then seed the baseline — **required**, registration fails without the default
`user` role:

```bash
pnpm seed:rbac   # idempotent: 3 roles + 8 permissions, safe to re-run
```

## 4. Redis (only if you need it)

Skip this unless `AUTH_STRATEGY=session-redis` or `RBAC_STRATEGY=db-live`.
For near-instant permission updates, you want `db-live`:

```bash
docker run -d --name auth-redis -p 6379:6379 redis:8
```

and set in `.env`:

```
RBAC_STRATEGY=db-live
REDIS_URL=redis://localhost:6379
```

(Keep `AUTH_STRATEGY=jwt-stateless` — `session-redis` is experimental.)

## 5. Run and verify

```bash
pnpm start:dev
```

Expect `HTTP server listening on port <PORT>`. Smoke test:

```bash
# passwords need lower + upper + digit + symbol
curl -X POST localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"Password123!"}'
```

You get back `{ data: { user, accessToken, refreshToken, expiresAt } }` with
`roles: ["user"]`. Login works the same way at `/auth/login`. Admin routes
(`GET /rbac-admin/roles`, …) need `manage:User` — assign yourself an admin
role via `POST /rbac-admin/users/<yourId>/roles` (from an admin account) or
edit grants directly in the DB.

## 6. Connect the frontend (optional)

In `../client`:

```bash
npm run dev -- -p 3001   # any port ≠ backend PORT
```

with `client/.env.local` containing:

```
NEXT_PUBLIC_API_URL=http://localhost:3000   # your backend PORT
```

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `refusing to start: NODE_ENV / DATABASE_URL` | No `.env` — copy `.example.env` |
| `REDIS_URL is required…` | Strategies set to `session-redis`/`db-live` without Redis — add `REDIS_URL` or revert to defaults |
| `EADDRINUSE 0.0.0.0:3000` | Port clash (often the frontend) — change `PORT` or move the frontend |
| `Default role "user" is missing` on register | Seed not run — `pnpm seed:rbac` |
| `password must contain…` (400) | Policy: lower + upper + digit + symbol |
| `Invalid email or password` (401) | Generic by design — also returned for locked/disabled/nonexistent accounts |
| `403` on `/rbac-admin/*` | Account lacks `manage:User` — assign the role |
| `login lockout is INACTIVE` WARN | No `REDIS_URL` — per-account lockout off, IP rate-limit only (fine for dev) |

## Appendix — the exact setup used for this project

Reference for what a completed setup looks like (backend on 8080 because the
Next.js client already owned 3000):

- **Containers:** `nest-auth-postgres` (`postgres:16`, `localhost:5432`, user/
  password/db `postgres/postgres/auth`), `nest-auth-redis` (`redis:8`,
  `localhost:6379`, no password)
- **Migrations** applied in order via `docker exec … psql … -f - < file`,
  then `pnpm seed:rbac` (baseline: 3 roles, 8 permissions)
- **`.env` highlights:** `PORT=8080`, `AUTH_STRATEGY=jwt-stateless`,
  `RBAC_STRATEGY=db-live`, `DB_PROVIDER=prisma`, `JWT_ALGORITHM=HS256`,
  `REDIS_URL=redis://localhost:6379`,
  `CORS_ORIGINS=http://localhost:3000,http://localhost:3001`
- **Client** (`../client`): runs on `:3000` with
  `NEXT_PUBLIC_API_URL=http://localhost:8080` in `client/.env.local`
- **DB was once fully truncated** (`TRUNCATE … CASCADE` on all 6 tables) and
  restored with `pnpm seed:rbac` — the supported way back to a working state

Two real bugs found and fixed during this setup (new clones already have the
fixes, documented here so the symptoms are searchable):

1. **`PORT` in `.env` was silently ignored** — `@nestjs/config` only writes
   schema-declared keys back to `process.env`, and `PORT` wasn't declared, so
   the server always fell back to 3000. Fixed by declaring
   `PORT: z.coerce.number().int().min(1).max(65535).default(3000)` in
   `src/config/env.schema.ts` (+ tests in `env.schema.spec.ts`).
2. **Browser `DELETE` calls failed CORS** while `POST` worked — the CORS
   plugin's default preflight answer allowed only `GET,HEAD,POST`, blocking
   the API's own detach/delete routes. Fixed with an explicit `methods` list
   in `registerCors` (`src/main.ts`).
