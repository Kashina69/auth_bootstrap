
# NestJS Auth + RBAC Bootstrap Template — Implementation Plan

## 0. Goal

A **drop-in, DB-backed, ORM-agnostic auth/RBAC module** for NestJS that:

- Handles authentication (JWT access + refresh, bcrypt/argon2 hashing).
- Handles authorization via **RBAC stored in the DB**, seeded from a single JSON file, with base roles/permissions out of the box, overridable at runtime via API or via re-running migrations/seeds from an updated JSON.
- Exposes RBAC as **pure, framework-agnostic functions** (`can()`, `hasRole()`, `hasPermission()`) that live in a standalone package/module with zero NestJS imports, so the exact same logic can run in a NestJS guard, a GraphQL resolver, or directly in a frontend (React/Vue/etc.) once it has the user's roles/permissions payload (e.g. decoded from the JWT).
- Ships REST + GraphQL parity for every auth/RBAC endpoint.
- Has rate limiting, helmet, CORS, validation, and other REST/GraphQL security hardening on by default.
- Uses a repository-pattern data layer so swapping Prisma → TypeORM → Drizzle → raw SQL touches only one folder.
- **Ships two interchangeable auth implementations and two interchangeable RBAC implementations, switchable by a single env var each, with zero code changes anywhere else in the app.**
- Has a clean, fully normalized baseline schema.

This is meant to be copy-pasted into `src/modules/` (or published as an internal npm package later) and work with minimal config.

---

## 1. Tech Stack

| Concern                    | Choice                                                                           | Why                                                                 |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Framework                  | NestJS (Fastify adapter)                                                         | Fastify > Express for perf; already your base                       |
| DB access                  | **Repository interfaces** + Prisma as default implementation               | Prisma has the best migration/seed DX; interfaces keep it swappable |
| DB                         | PostgreSQL                                                                       | Best fit for relational RBAC + row-level constraints                |
| Auth                       | `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`                          | Standard, battle-tested                                             |
| Session store (strategy 2) | `ioredis`                                                                      | Backing store for server-side sessions & permission cache           |
| Password hashing           | `argon2` (fallback `bcrypt`)                                                 | Argon2id is current best practice                                   |
| Rate limiting              | `@nestjs/throttler` (+ Redis storage for multi-instance)                       | Native Nest integration                                             |
| Validation                 | `class-validator` / `class-transformer` (REST), same DTOs reused for GraphQL | Nest-native                                                         |
| GraphQL                    | `@nestjs/graphql` + Apollo (code-first)                                        | Matches REST DTOs 1:1 via shared schema                             |
| Security headers           | `@fastify/helmet`, `@fastify/csrf-protection` (if cookies used)              | Standard hardening                                                  |
| Secrets/config             | `@nestjs/config` + `zod`-validated env schema                                | Fail fast on bad config                                             |
| Testing                    | Vitest (already in your repo)                                                    | Matches existing config                                             |

---

## 2. High-Level Architecture

```
src/
├── config/                     # env schema + typed config service
├── common/
│   ├── decorators/              # @CurrentUser, @Roles, @Permissions, @Public
│   ├── filters/                 # global exception filter
│   ├── interceptors/            # logging, timeout, transform
│   ├── guards/                  # AuthGuard, RbacGuard, ThrottlerGuard
│   └── pipes/
├── rbac-core/                   # ⭐ FRAMEWORK-AGNOSTIC — publishable standalone
│   ├── types.ts                 # Role, Permission, AuthzContext types
│   ├── can.ts                   # pure can(), hasRole(), hasAnyPermission()
│   ├── policy-registry.ts       # in-memory resolved policy tree
│   └── index.ts                 # single export surface — usable in frontend
├── auth-strategies/              # ⭐ pluggable auth implementations (see §3)
│   ├── auth-strategy.interface.ts
│   ├── jwt-stateless/            # strategy A
│   └── session-redis/            # strategy B
├── rbac-strategies/               # ⭐ pluggable RBAC implementations (see §3)
│   ├── authorization-provider.interface.ts
│   ├── embedded-claims/          # strategy A
│   └── db-live/                  # strategy B
├── database/
│   ├── seed/
│   │   ├── rbac.seed.json       # ⭐ base roles/permissions source of truth
│   │   └── rbac.seed.ts         # reads json → upserts DB
│   ├── migrations/
│   ├── prisma/schema.prisma     # default ORM impl
│   └── repositories/            # interfaces + prisma implementations
│       ├── user.repository.ts (interface)
│       ├── prisma-user.repository.ts (impl)
│       ├── role.repository.ts / prisma-role.repository.ts
│       └── permission.repository.ts / prisma-permission.repository.ts
├── modules/
│   ├── auth/
│   │   ├── auth.module.ts        # dynamic module — wires the chosen strategy
│   │   ├── auth.controller.ts    # REST: /auth/*  (strategy-agnostic)
│   │   ├── auth.resolver.ts      # GraphQL parity (strategy-agnostic)
│   │   └── dto/
│   ├── users/
│   ├── rbac-admin/               # manage roles/permissions at runtime
│   │   ├── rbac-admin.module.ts
│   │   ├── rbac-admin.controller.ts
│   │   └── rbac-admin.resolver.ts
│   └── sessions/                 # refresh-token / device-session tracking
├── app.module.ts
└── main.ts
```

Key design decision: **`rbac-core/` has no NestJS or DB imports.** It only knows about plain objects: `{ roles: string[], permissions: string[] }`. A NestJS guard calls it. A frontend can call the *exact same compiled package* once it has the user's roles/permissions.

---

## 3. Pluggable Strategy Architecture (the "0-effort switch")

You asked for two swappable implementations each for **auth** and **RBAC**, toggled by a single env var, with nothing else in the app changing. Design:

### 3.1 The trick: program to interfaces, select the implementation at DI-registration time

```ts
// auth-strategies/auth-strategy.interface.ts
export interface IAuthStrategy {
  login(credentials: LoginDto, meta: RequestMeta): Promise<AuthResult>;
  refresh(refreshInput: unknown, meta: RequestMeta): Promise<AuthResult>;
  logout(userId: string, sessionRef: unknown): Promise<void>;
  validateRequest(req: FastifyRequest): Promise<AuthenticatedUser | null>; // used by AuthGuard
}
```

```ts
// rbac-strategies/authorization-provider.interface.ts
export interface IAuthorizationProvider {
  getContext(user: AuthenticatedUser): Promise<AuthzContext>; // { roles, permissions }
  invalidate(userId: string): Promise<void>; // no-op for embedded-claims, real for db-live
}
```

Every controller, resolver, guard, and the `rbac-core.can()` calls **only ever talk to `IAuthStrategy` / `IAuthorizationProvider`**, injected via DI tokens (`AUTH_STRATEGY_TOKEN`, `AUTHZ_PROVIDER_TOKEN`). They never import a concrete strategy class directly. This is what makes the swap zero-effort — nothing downstream knows or cares which concrete class it got.

### 3.2 Selecting the implementation from one env var

```ts
// auth-strategies/auth-strategies.module.ts
@Global()
@Module({})
export class AuthStrategiesModule {
  static register(): DynamicModule {
    return {
      module: AuthStrategiesModule,
      imports: [ConfigModule],
      providers: [
        {
          provide: AUTH_STRATEGY_TOKEN,
          useFactory: (config: AppConfig, jwtSvc, sessionRepo, redis) => {
            switch (config.AUTH_STRATEGY) {
              case 'session-redis':
                return new SessionRedisAuthStrategy(sessionRepo, redis, config);
              case 'jwt-stateless':
              default:
                return new JwtStatelessAuthStrategy(jwtSvc, sessionRepo, config);
            }
          },
          inject: [AppConfig, JwtService, RefreshTokenRepository, 'REDIS_CLIENT'],
        },
      ],
      exports: [AUTH_STRATEGY_TOKEN],
    };
  }
}
```

Same pattern for `RbacStrategiesModule.register()` keyed off `RBAC_STRATEGY`. Both modules are `@Global()` and imported once in `AppModule`, so the correct concrete class is resolved a single time at boot, and every consumer downstream just injects the interface token.

**Env config (one line each):**

```env
AUTH_STRATEGY=jwt-stateless      # or: session-redis
RBAC_STRATEGY=embedded-claims    # or: db-live
```

Changing either value + restarting the app is the entire migration — no code touched. (Swapping *while users have active sessions* invalidates those sessions, since the two auth strategies use incompatible session formats — documented as an operational note, not a code concern.)

### 3.3 The four implementations, with trade-offs

**Auth strategy A — `jwt-stateless`** (default)
Short-lived signed JWT access token (self-contained, no DB hit to validate) + rotating opaque refresh token (hash stored in `refresh_tokens` table).

- ✅ Horizontally scalable with zero shared state for the hot path (access-token validation is pure crypto, no DB/Redis round trip).
- ✅ Works great for mobile apps / third-party API consumers / microservices that need to validate tokens locally.
- ❌ Logout/ban doesn't take effect until access-token TTL expires (mitigated by short TTL, e.g. 10–15 min).
- ❌ Token payload grows if you cram in lots of claims.
- **Use when:** public API, mobile clients, multi-service architecture, need to scale auth-checks without a shared cache.

**Auth strategy B — `session-redis`**
Opaque, unguessable session ID in an `httpOnly`, `sameSite=strict` cookie; session data (`userId`, issued/expiry, device meta) lives server-side in Redis.

- ✅ Instant logout/ban/revocation — just delete the Redis key.
- ✅ No sensitive claims ever sent to the client; smaller attack surface for XSS token theft.
- ✅ Simplest mental model for a single first-party web app.
- ❌ Every authenticated request costs a Redis round trip.
- ❌ Needs Redis in every environment (extra infra dependency); less natural for native mobile or 3rd-party API consumers.
- **Use when:** first-party web app (your own frontend only), instant-revocation is a hard requirement (banking/admin panels), you're fine running Redis.

**RBAC strategy A — `embedded-claims`** (default)
Roles + resolved `action:subject` permission strings are baked into the auth payload (JWT claims, or the Redis session blob) at login/refresh time. `RbacGuard` reads them straight off `request.user`, no DB call, pure in-memory `can()` check.

- ✅ Zero DB/cache cost per authorization check — fastest option.
- ✅ Identical object shape ships to the frontend (decode JWT or read `/auth/me`), so `rbac-core.can()` runs client-side with the same data, same semantics.
- ❌ Permission changes are stale until the user's session/token next refreshes.
- **Use when:** permission changes are infrequent relative to request volume (typical SaaS), you want the frontend to gate UI instantly without a network call.

**RBAC strategy B — `db-live`**
`RbacGuard` calls `IAuthorizationProvider.getContext(user)`, which queries current roles/permissions from the DB on each request (behind a short-TTL cache, e.g. 5–10s in Redis, invalidated immediately on any role/permission mutation via `invalidate(userId)`).

- ✅ Permission/role changes take effect on the very next request — true instant revocation ("kick this user out of admin *right now*").
- ✅ No stale-token window at all.
- ❌ Extra DB/cache hit per authorized request (mitigated by the short-TTL cache).
- ❌ Frontend can't independently evaluate `can()` offline the same way — needs `/auth/me` or a `/authz/check` endpoint for parity, since the frontend has no live DB connection. (Ship both: `rbac-core.can()` for optimistic UI gating, plus a lightweight `/authz/check` REST/GraphQL endpoint the frontend calls before destructive actions, for the authoritative answer.)
- **Use when:** RBAC changes need to be effective immediately (compliance-sensitive apps, admin can instantly de-provision access), permission-check volume is manageable with caching.

### 3.4 Compatibility matrix

All four combinations are valid and interchangeable independently — `AUTH_STRATEGY` and `RBAC_STRATEGY` are orthogonal env vars:

|                             | `embedded-claims`                                                                                                                | `db-live`                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **`jwt-stateless`** | Fastest overall; fully stateless auth*and* authz. Best default for public/scalable APIs.                                         | Stateless auth, live-checked authz — good middle ground: scalable login/refresh, instant permission revocation, small per-request cache hit. |
| **`session-redis`** | Instant auth revocation, but permission changes still wait for session refresh — slightly inconsistent, rarely the right pairing. | Fully live on both axes — safest option for admin/compliance-heavy apps, highest per-request cost (two Redis/DB touches).                    |

Recommended pairings to document in the README: `jwt-stateless` + `embedded-claims` (default, scalable), and `session-redis` + `db-live` (max control, single first-party app).

---

## 4. Database Schema (normalized, ORM-agnostic — shown as SQL/ER, implemented first in Prisma)

```
users
├── id (uuid, pk)
├── email (citext, unique)
├── password_hash
├── is_active (bool)
├── is_email_verified (bool)
├── created_at, updated_at, deleted_at (soft delete)

roles
├── id (uuid, pk)
├── name (unique)              -- e.g. "admin", "editor"
├── description
├── is_system (bool)           -- seeded/base roles, not deletable via API
├── created_at, updated_at

permissions
├── id (uuid, pk)
├── action (e.g. "create", "read", "update", "delete", "manage")
├── subject (e.g. "Post", "User", "Invoice")   -- resource this applies to
├── name (unique, generated: "{action}:{subject}")
├── description
├── created_at

role_permissions            -- many-to-many join
├── role_id (fk → roles)
├── permission_id (fk → permissions)
├── PRIMARY KEY (role_id, permission_id)

user_roles                  -- many-to-many join (supports multi-role users)
├── user_id (fk → users)
├── role_id (fk → roles)
├── assigned_by (fk → users, nullable)
├── assigned_at
├── PRIMARY KEY (user_id, role_id)

refresh_tokens               -- used by jwt-stateless; also doubles as device list for session-redis
├── id (uuid, pk)
├── user_id (fk → users)
├── token_hash                -- never store raw token
├── user_agent, ip
├── expires_at
├── revoked_at (nullable)
├── created_at

-- optional, for fine-grained resource-level rules beyond role defaults:
role_permission_conditions   -- ABAC-lite escape hatch (JSON field conditions)
├── id (uuid, pk)
├── role_permission fk-composite
├── conditions (jsonb)        -- e.g. { "ownerOnly": true }
```

Notes:

- `permissions.name` is a **generated `action:subject` string** — this is what actually travels in the JWT/session and is what `rbac-core.can()` checks against. Keeps the payload small and check logic trivial (`Set.has()`).
- `is_system` on roles prevents accidental deletion of `admin`/base roles via the runtime API.
- Schema is identical regardless of which of the 4 strategies is active — the strategy choice only changes *where the check happens and how fresh it is*, never the source of truth.
- `role_permission_conditions` is optional — omit at v1 if you only need pure RBAC, not RBAC+ownership checks. Documented as a future extension point.

---

## 5. RBAC Seed Flow (JSON → DB → runtime-editable)

**`database/seed/rbac.seed.json`** — single source of truth for the *baseline*:

```json
{
  "permissions": [
    { "action": "manage", "subject": "all" },
    { "action": "create", "subject": "Post" },
    { "action": "read", "subject": "Post" },
    { "action": "update", "subject": "Post" },
    { "action": "delete", "subject": "Post" },
    { "action": "read", "subject": "User" },
    { "action": "manage", "subject": "User" }
  ],
  "roles": [
    { "name": "superadmin", "isSystem": true, "permissions": ["manage:all"] },
    { "name": "admin", "isSystem": true, "permissions": ["manage:User", "manage:Post"] },
    { "name": "user", "isSystem": true, "permissions": ["read:Post", "create:Post"] }
  ]
}
```

Flow:

1. `pnpm seed:rbac` runs `rbac.seed.ts`, which **upserts** (never blind-inserts) permissions and roles from the JSON, so re-running is idempotent and safe against DB drift.
2. After baseline exists, **all further changes go through `rbac-admin` REST/GraphQL endpoints** (create role, attach permission to role, assign role to user) — normal DB writes, no redeploy needed.
3. If you want to ship a *new baseline* later (e.g. adding a module to your product), update the JSON and re-run the seed script (or wrap it as a migration step) — it merges additively, existing custom roles/grants are untouched.
4. `is_system = true` roles/permissions from the JSON are protected from deletion via the admin API (soft guard in the service layer), but their permission attachments can still be extended.
5. Under `db-live`, a role/permission mutation calls `IAuthorizationProvider.invalidate(userId)` for every affected user so the next request sees fresh data immediately; under `embedded-claims`, changes are picked up on next token/session refresh.

---

## 6. Auth Flow (strategy-agnostic surface, strategy-specific internals)

- **Register** → hash password (argon2id) → create user → assign default `user` role → call `IAuthStrategy.login()`.
- **Login** → verify password → `IAuthStrategy.login()` issues whatever the active strategy produces (JWT pair, or Redis session + cookie) → response shape to the client is identical either way: `{ user, expiresAt }` with the token/cookie delivered per strategy's transport.
- **Refresh** → `IAuthStrategy.refresh()` — rotates JWT pair, or extends the Redis session TTL.
- **Logout** → `IAuthStrategy.logout()` — revokes the refresh token row, or deletes the Redis session key.
- **Authorization check** (`AuthGuard` + `RbacGuard`) → `AuthGuard` calls `IAuthStrategy.validateRequest()` to resolve `request.user`; `RbacGuard` calls `IAuthorizationProvider.getContext(user)` to get `{ roles, permissions }`, then `rbac-core.can()` decides. Controllers/resolvers never see which concrete strategy ran.

---

## 7. `rbac-core` — the portable authorization layer

```ts
// rbac-core/types.ts
export interface AuthzContext {
  roles: string[];
  permissions: string[]; // "action:subject" strings, e.g. "manage:all"
}

// rbac-core/can.ts
export function can(ctx: AuthzContext, action: string, subject: string): boolean {
  const perms = new Set(ctx.permissions);
  return perms.has('manage:all') || perms.has(`manage:${subject}`) || perms.has(`${action}:${subject}`);
}

export function hasRole(ctx: AuthzContext, role: string): boolean {
  return ctx.roles.includes(role);
}

export function hasAnyPermission(ctx: AuthzContext, perms: string[]): boolean {
  return perms.some((p) => ctx.permissions.includes(p) || ctx.permissions.includes('manage:all'));
}
```

- **Backend usage:** `RbacGuard` calls `can()`/`hasRole()` against metadata set by `@Permissions('update:Post')` / `@Roles('admin')` decorators — one guard, works identically for REST controllers and GraphQL resolvers, and identically regardless of which of the two RBAC strategies is active, since both ultimately hand it the same `AuthzContext` shape.
- **Frontend usage:** get `{ roles, permissions }` from the decoded JWT (`embedded-claims`) or from `/auth/me` (`db-live`), import the same zero-dependency `can()`/`hasRole()` functions, and gate UI with identical semantics to the backend.

---

## 8. Security Hardening Checklist (applied at bootstrap, strategy-independent)

- **Helmet** (`@fastify/helmet`) — CSP, HSTS, X-Frame-Options, etc.
- **Rate limiting** — global `ThrottlerModule` (e.g. 100 req/min/IP default), stricter named throttlers on `/auth/login`, `/auth/register`, `/auth/refresh` (e.g. 5 req/min). Redis-backed storage if running >1 instance (already present if `session-redis` and/or `db-live` are active; add Redis regardless if you scale beyond one instance under `jwt-stateless` + `embedded-claims`).
- **CORS** — explicit allow-list from env, not `*`.
- **Validation** — global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`; GraphQL inputs validated via the same class-validator DTOs.
- **CSRF** — required for `session-redis` (cookie-based) — `@fastify/csrf-protection` enabled automatically when that strategy is active; not needed for `jwt-stateless` with header-delivered access tokens (refresh cookie, if used, still gets `sameSite=strict` + CSRF token as defense in depth).
- **Password policy** — enforced in DTO (`class-validator` regex) + argon2id hashing with tuned memory/time cost.
- **Brute-force lockout** — failed-login counter per user/IP with exponential backoff (Redis).
- **GraphQL-specific** — disable introspection + playground in production, query depth/complexity limiting (`graphql-depth-limit`, `graphql-query-complexity`).
- **Secrets** — `.env` validated via zod schema at boot (`ConfigModule` with `validate`), app refuses to start on missing/invalid secrets, including `AUTH_STRATEGY`/`RBAC_STRATEGY` being one of the allowed enum values. JWT signing secret ≥256-bit (only required when `jwt-stateless` is active).
- **Audit log table** (optional v1.1) — record role/permission changes and auth-strategy-relevant events (logout-all, session revocation) for traceability.

---

## 9. ORM/DB Replaceability

- All DB access goes through **repository interfaces** (`UserRepository`, `RoleRepository`, `PermissionRepository`, `RefreshTokenRepository`) defined with plain TS interfaces + NestJS DI tokens, never imported directly by services — same pattern used for the auth/RBAC strategy swap in §3.
- `database/repositories/prisma-*.repository.ts` is the default implementation, bound in a `DatabaseModule` via `useClass`/`useFactory`.
- To swap ORMs: implement the same interfaces against TypeORM/Drizzle/raw `pg`, rebind the providers in `DatabaseModule`, keep every service/controller/resolver/strategy untouched.
- Migrations live under `database/migrations/` using Prisma Migrate by default; documented how to regenerate the equivalent under a different ORM's migration tool.

---

## 10. GraphQL/REST Parity Pattern

- One DTO set (`class-validator` decorated) reused as both the REST body type and the GraphQL `InputType` (via `@nestjs/graphql`'s decorators stacked on the same class).
- One service method per operation (`authService.login()` → delegates to `IAuthStrategy`) called from both `auth.controller.ts` (REST) and `auth.resolver.ts` (GraphQL) — no business logic duplicated per transport, and no strategy-specific branching leaks into either.
- `AuthGuard` and `RbacGuard` both implement `CanActivate` using `GqlExecutionContext.create(context).getContext()` so they work unmodified on either transport and under either strategy.

---

## 11. Build Phases

1. **Phase 0 — Scaffolding:** `@nestjs/config` + zod env validation (including `AUTH_STRATEGY`/`RBAC_STRATEGY` enums), Fastify adapter, helmet, global pipes/filters/interceptors, Vitest wiring.
2. **Phase 1 — DB layer:** Prisma schema for the schema in §4, initial migration, repository interfaces + Prisma implementations, `DatabaseModule`.
3. **Phase 2 — RBAC core:** `rbac-core/` package (pure functions), `rbac.seed.json` + seed script, run baseline seed.
4. **Phase 3 — Strategy interfaces + DI wiring:** `IAuthStrategy`, `IAuthorizationProvider`, `AuthStrategiesModule.register()`, `RbacStrategiesModule.register()`, env-driven factory providers (§3) — built early so every later phase codes against the interfaces, not a concrete strategy.
5. **Phase 4 — Auth strategy A (`jwt-stateless`):** argon2 hashing, JWT strategies, refresh-token rotation + revocation.
6. **Phase 5 — Auth strategy B (`session-redis`):** Redis session store, cookie issuance, CSRF wiring.
7. **Phase 6 — RBAC strategy A (`embedded-claims`):** claims resolution at login/refresh time, baked into token/session payload.
8. **Phase 7 — RBAC strategy B (`db-live`):** live DB lookup + short-TTL cache + `invalidate()` hooks wired into `rbac-admin` mutations.
9. **Phase 8 — Guards/decorators:** `@Roles`, `@Permissions`, `@Public`, `AuthGuard`, `RbacGuard` — written once against the interfaces, works across all 4 combinations without modification.
10. **Phase 9 — RBAC admin API:** REST + GraphQL CRUD for roles/permissions/assignments, protected by `manage:User`/`manage:all`.
11. **Phase 10 — GraphQL parity:** resolvers mirroring every REST auth/rbac-admin endpoint, query complexity/depth limits.
12. **Phase 11 — Security hardening pass:** throttler tuning per-route, brute-force lockout, CORS/CSRF finalization (strategy-conditional), security headers audit.
13. **Phase 12 — Frontend integration kit:** publish/export `rbac-core` for frontend consumption, example React hook (`usePermission()`), `/auth/me` and `/authz/check` endpoints.
14. **Phase 13 — Tests:** unit tests for `rbac-core.can()` and each of the 4 strategy implementations in isolation, e2e tests run twice — once per `AUTH_STRATEGY` value — against the same test suite (strategies are interchangeable, so the same e2e spec file validates both).

---

## 12. Open Decisions to Confirm Before Coding

- Default strategy pairing to ship as the out-of-the-box config: recommend `AUTH_STRATEGY=jwt-stateless` + `RBAC_STRATEGY=embedded-claims`.
- Multi-role per user: confirmed needed (schema above supports it).
- `db-live` cache TTL: proposed 5–10s — confirm acceptable staleness window, or drop caching entirely if permission-check volume is low.
- Whether `role_permission_conditions` (ABAC-lite) is in scope for v1 or deferred.
