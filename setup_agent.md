# Setup Agent Playbook — auth service

> **How to use this file:** paste it (plus the path to this repo) to any AI
> coding agent and tell it to follow the playbook. It will inspect the
> machine, **ask the user the questions in Phase 1 before doing anything**,
> then set the project up end to end.

---

## Role

You are onboarding a developer onto the `auth/` backend in this repo. Your
job: get `pnpm start:dev` booting cleanly with a working database (and Redis
if wanted), verified by a real register/login round-trip. Prefer asking over
assuming whenever a choice affects their machine or credentials.

## Ground rules

1. **Read-only first.** Before changing anything, read `package.json`,
   `src/config/env.schema.ts` (the source of truth for required env),
   `.example.env`, and list `src/database/migrations/` in order.
2. **Never commit secrets.** `.env` is local-only. If `.env` isn't git-ignored,
   warn the user — do not stage or commit it.
3. **Additive by default.** Starting new Docker containers is fine. Do NOT
   stop, remove, or wipe the user's pre-existing containers, volumes, or
   databases without explicit confirmation. `TRUNCATE`/dropping data always
   requires a yes.
4. **Don't "fix" app code to get setup working.** If boot fails for a code
   reason, report it and stop — setup problems are env/infra problems.
5. **Verify, don't declare victory.** Every phase ends with a check whose
   output you actually read (container `Status`, migration output, HTTP
   status codes).

## Phase 0 — Inspect the machine (no questions yet)

Run and record:

- `node -v` (need 20+), `pnpm -v` (install if missing: `corepack enable`)
- `docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'` — what's already
  running? Note any Postgres/Redis and their ports.
- `docker images | grep -iE 'postgres|redis|mongo'` — what's cached locally?
- Is anything listening on the candidate backend port (default 3000) and the
  likely frontend port (3000/3001)? (`ss -ltn`)
- Does a Postgres/MongoDB/Redis run natively (not in Docker)? Check common
  ports 5432 / 27017 / 6379.

## Phase 1 — Ask the user (MANDATORY before acting)

Ask these in one round, each with a recommended default. Do not proceed to
Phase 2 until answered:

1. **Docker or native?** "I found [X]. Should I run the project's database
   in Docker (default, nothing installed on your machine), or connect to a
   database you already have?" If existing: ask host, port, username,
   password, database name.
2. **Database passwords.** If creating fresh Docker containers, propose
   defaults (`postgres/postgres`, db `auth`) and let them override. If
   connecting to theirs, ask for credentials (never print them back in full).
3. **Redis?** "Do you want Redis? You need it for `db-live` (permission
   changes apply on the next request instead of next login) and login
   lockout. Docker default, or an existing instance, or skip it (pure
   defaults, no Redis features)."
4. **Ports.** "Backend defaults to 3000. I see [port status] — keep 3000 or
   use another (e.g. 8080)? Where will your frontend run (for CORS)?"
5. **JWT mode.** "Local-dev shortcut `HS256` with a generated secret
   (default), or production-style `RS256` (you'll paste a PEM key pair)?"
6. **Seed?** "Run `pnpm seed:rbac` for the baseline roles/permissions?
   (Required — registration fails without it. Idempotent, safe to re-run.)"

## Phase 2 — Execute

1. `pnpm install` in `auth/`.
2. Write `.env` from the answers (use `.example.env` as the template; keep
   a backup of any existing `.env` as `.env.bak` first).
3. Start/provision infrastructure:
   - Docker Postgres (example): `docker run -d --name auth-postgres -e
     POSTGRES_PASSWORD=<pw> -e POSTGRES_DB=auth -p 5432:5432 postgres:16`,
     then wait for `pg_isready`.
   - Docker Redis (if wanted): `docker run -d --name auth-redis -p
     6379:6379 redis:8`, then `redis-cli ping` → `PONG`.
   - Existing DB: verify connectivity first (`psql` / `mongosh` / `redis-cli`
     ping) before continuing.
4. Apply migrations **in filename order** from `src/database/migrations/`
   (`psql … -v ON_ERROR_STOP=1 -f - < <file>`). Skip only for
   `DB_PROVIDER=mongoose`.
5. `pnpm seed:rbac` (if user agreed) — expect `baseline ready: N
   permissions, M roles`.
6. Boot: `pnpm start:dev`. `PORT` in `.env` is honored (schema-validated);
   a shell `PORT=<n>` prefix overrides it per-run. Expect `HTTP server
   listening on port <PORT>`. Leave THEIR foreground process to them — verify with your own
   temporary instance or curl against theirs, then clean up anything you
   started temporarily so ports are free.
7. Smoke test and read the bodies, don't just check status codes:
   `POST /auth/register` → expect `roles: ["user"]` in `data.user`;
   `POST /auth/login` → token pair. Passwords must contain lower + upper +
   digit + symbol. If the user is keeping the DB, ask before leaving test
   accounts behind — otherwise delete them.

## Phase 3 — Report back

Summarize: what runs where (backend port, DB host/port/name, Redis if any),
which strategies are active and what that implies (e.g. `db-live` = instant
grant updates; `embedded-claims` = changes apply on refresh), exact commands
to restart everything, and anything you deliberately left for them (e.g.
production JWT keys, `.env` git-ignore status). End with the one-line
proof: the register/login responses you observed.
