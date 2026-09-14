# CONTRACTS.md — Frozen Interfaces

The interfaces every agent codes against. **Interface changes require orchestrator
sign-off** — a worker never edits this file unilaterally. Seeded from `plan.md` §3.1,
§4, §7, §9 and `implementation.spec.md`.

Source of truth: `plan.md` (architecture), `implementation.spec.md` (security-critical
code). This file is the frozen subset that must not drift during the build.

---

## 1. DI tokens (shared constants)

```ts
// common/constants.ts
export const AUTH_STRATEGY_TOKEN = Symbol('AUTH_STRATEGY_TOKEN');
export const AUTHZ_PROVIDER_TOKEN = Symbol('AUTHZ_PROVIDER_TOKEN');
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');
export const PERMISSION_REPOSITORY = Symbol('PERMISSION_REPOSITORY');
export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');
export const DB_CLIENT = Symbol('DB_CLIENT');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

// Reflector metadata keys (decorators)
export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';
```

## 2. Core domain types (framework-agnostic — `rbac-core`)

```ts
// rbac-core/types.ts
export interface AuthzContext {
  roles: string[];
  permissions: string[]; // "action:subject" strings, e.g. "manage:all"
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  isActive: boolean;
  isEmailVerified: boolean;
  // Populated ONLY by the embedded-claims RBAC strategy (baked into the JWT/session at
  // login/refresh). db-live leaves these empty and resolves them via a live DB lookup in
  // IAuthorizationProvider.getContext(). Guards never trust a client-supplied value here.
  roles?: string[];
  permissions?: string[];
}
```

## 3. Auth strategy contract

```ts
// auth-strategies/auth-strategy.interface.ts
export interface RequestMeta {
  userAgent: string;
  ip: string;
}

export interface AuthResult {
  user: AuthenticatedUser;
  expiresAt: string; // ISO-8601
  // transport is strategy-specific: jwt pairs set accessToken/refreshToken,
  // session-redis sets a cookie on the response object.
  accessToken?: string;
  refreshToken?: string;
}

export interface IAuthStrategy {
  // `login` receives the already-authenticated user — the auth service (modules/auth/)
  // does the lookup + password verification. Strategies stay free of UserRepository/
  // PasswordService (see §10 constructor signatures).
  login(user: AuthenticatedUser, meta: RequestMeta): Promise<AuthResult>;
  refresh(refreshInput: unknown, meta: RequestMeta): Promise<AuthResult>;
  logout(userId: string, sessionRef: unknown): Promise<void>;
  validateRequest(req: FastifyRequest): Promise<AuthenticatedUser | null>; // used by AuthGuard
}
```

## 4. Authorization provider contract

```ts
// rbac-strategies/authorization-provider.interface.ts
export interface IAuthorizationProvider {
  getContext(user: AuthenticatedUser): Promise<AuthzContext>;
  invalidate(userId: string): Promise<void>; // no-op for embedded-claims, real for db-live
}
```

## 5. Repository contracts (`database/repositories/*`)

Every ORM adapter (Prisma, Drizzle, Sequelize, Mongoose) implements these verbatim and
normalizes "not found" to `null` (never an ORM-specific exception).

```ts
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(data: { email: string; passwordHash: string }): Promise<User>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  assignRole(userId: string, roleId: string): Promise<void>; // idempotent
  findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }>;
  findUserIdsByRole(roleId: string): Promise<string[]>; // holders of a role — plan §5.5 invalidate() fan-out
}

export interface RoleRepository {
  findById(id: string): Promise<Role | null>;
  findByName(name: string): Promise<Role | null>;
  findAll(): Promise<Role[]>;
  create(data: { name: string; description?: string; isSystem?: boolean }): Promise<Role>;
  attachPermissions(roleId: string, permissionIds: string[]): Promise<void>;
  detachPermissions(roleId: string, permissionIds: string[]): Promise<void>; // idempotent
  listPermissions(roleId: string): Promise<Permission[]>;
  delete(id: string): Promise<void>;
}

export interface PermissionRepository {
  findById(id: string): Promise<Permission | null>;
  findByName(name: string): Promise<Permission | null>;
  findAll(): Promise<Permission[]>;
  create(data: { action: string; subject: string; description?: string; isSystem?: boolean }): Promise<Permission>;
  delete(id: string): Promise<void>;
}

export interface RefreshTokenRepository {
  create(data: RefreshTokenCreate): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  markRevoked(id: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}
```

Where the entity shapes are:

```ts
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

export interface Permission {
  id: string;
  action: string;
  subject: string;
  name: string; // generated "{action}:{subject}"
  description: string | null;
  isSystem: boolean; // maps the existing is_system column — baseline permissions are undeletable
}

export interface RefreshTokenCreate {
  userId: string;
  tokenHash: string;
  familyId: string;
  userAgent: string;
  ip: string;
  expiresAt: Date;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  userAgent: string;
  ip: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}
```

## 6. DTO shapes (shared REST + GraphQL)

```ts
// modules/auth/dto/
export class LoginDto {
  email: string;
  password: string;
}
export class RegisterDto {
  email: string;
  password: string; // min 8 chars, @Matches strength regex
}
export class RefreshDto {
  refreshToken: string;
}
```

## 7. Env schema (zod) — the strategy/provider enums are FROZEN

```ts
AUTH_STRATEGY: 'jwt-stateless' | 'session-redis'      // default 'jwt-stateless'
RBAC_STRATEGY: 'embedded-claims' | 'db-live'           // default 'embedded-claims'
DB_PROVIDER: 'prisma' | 'drizzle' | 'sequelize' | 'mongoose'  // default 'prisma'
JWT_ALGORITHM: 'RS256' | 'HS256'                       // default 'RS256'
```

Full validation rules (RS256 keys, HS256 secret min 32, REDIS_URL required when
session-redis/db-live) live in `implementation.spec.md` §8 — not repeated here.

## 8. RBAC core functions (frozen, zero-dependency)

```ts
export function can(ctx: AuthzContext, action: string, subject: string): boolean;
export function hasRole(ctx: AuthzContext, role: string): boolean;
export function hasAnyPermission(ctx: AuthzContext, perms: string[]): boolean;
```

`can()` semantics (from `implementation.spec.md` §4):
`manage:all` OR `manage:{subject}` OR `{action}:{subject}`, default-deny on malformed
input, `subject` is case-sensitive and must match `permissions.subject` verbatim.

## 9. Security invariants (non-negotiable, from `implementation.spec.md`)

- argon2id hashing; never `===` on passwords.
- JWT verify pins `algorithms: [...]`, `issuer`, `audience`.
- Raw refresh token never stored — only SHA-256 hash; rotate on every use; reuse
  detection revokes the whole token family.
- Login failure message identical for "no such user" vs "wrong password".
- `can()` default-deny.
- `AuthGuard` runs before `RbacGuard`; routes deny-by-default.
- CSRF on only when cookie sessions active.
- App refuses to boot on invalid secrets.

## 10. Strategy constructor signatures (frozen)

Frozen by the strategy-interfaces wave. Wave 4 agents fill in the method **bodies** of
these classes and must NOT change the class names, the constructor parameter lists
(types or order), the module files, or the factory `inject` arrays below. Everything the
constructors receive is already wired by `AuthStrategiesModule.register()` /
`RbacStrategiesModule.register()`.

### Concrete classes

```ts
// auth-strategies/jwt-stateless/jwt-stateless.auth-strategy.ts
export class JwtStatelessAuthStrategy implements IAuthStrategy {
  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly users: UserRepository,   // re-resolves identity + claims fresh on refresh
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}
}

// auth-strategies/session-redis/session-redis.auth-strategy.ts
export class SessionRedisAuthStrategy implements IAuthStrategy {
  constructor(
    private readonly redis: Redis,          // ioredis, injected as REDIS_CLIENT
    private readonly config: AppConfig,
  ) {}
}

// rbac-strategies/embedded-claims/embedded-claims.authorization-provider.ts
export class EmbeddedClaimsAuthorizationProvider implements IAuthorizationProvider {
  constructor(private readonly config: AppConfig) {}
}

// rbac-strategies/db-live/db-live.authorization-provider.ts
export class DbLiveAuthorizationProvider implements IAuthorizationProvider {
  constructor(
    private readonly users: UserRepository,
    private readonly redis: Redis,          // ioredis, injected as REDIS_CLIENT
    private readonly config: AppConfig,
  ) {}
}
```

`Redis` is the `ioredis` default/named export. `AppConfig` is the validated-config
service from `config/app-config.service.ts`; JWT issuer/audience/TTLs are NOT on it —
read them from `config/constants.ts` (`DEFAULT_JWT_*`). `JwtService` comes from
`JwtModule.registerAsync()` inside `AuthStrategiesModule`, driven by `AppConfig`
(RS256 → private/public key, HS256 → secret).

### Factory `inject` arrays (`src/*-strategies/*.module.ts`)

```ts
// AuthStrategiesModule.register()
inject: [AppConfig, JwtService, REFRESH_TOKEN_REPOSITORY, USER_REPOSITORY, REDIS_CLIENT]

// RbacStrategiesModule.register()
inject: [AppConfig, USER_REPOSITORY, REDIS_CLIENT]
```

Both modules are `@Global()`, provide their token (`AUTH_STRATEGY_TOKEN` /
`AUTHZ_PROVIDER_TOKEN`) via `useFactory` keyed off `AppConfig.AUTH_STRATEGY` /
`AppConfig.RBAC_STRATEGY`, and export only that token. Each module also provides its own
`REDIS_CLIENT`: a real `ioredis` client when the module's own strategy needs Redis and
`REDIS_URL` is set, otherwise a stub that throws on any method call (so DI resolves under
the default Redis-free env).

## 11. Auth module surface (`modules/auth/`) — added Wave 8

Promoted here on Wave 8's recommendation (Wave 5's checkpoint asked for it and it was never
written). Nothing in §1–§10 changed to accommodate it; this records what already existed and
what Wave 8 added, so a future agent stops having to read `modules/auth/` to learn the shape.

```ts
// modules/auth/auth.service.ts — frozen since Wave 5, unchanged
class AuthService {
  register(dto: RegisterDto, meta: RequestMeta): Promise<AuthResult>;
  login(dto: LoginDto, meta: RequestMeta): Promise<AuthResult>;
  refresh(dto: RefreshDto, meta: RequestMeta): Promise<AuthResult>;
  logout(user: AuthenticatedUser, sessionRef: unknown): Promise<void>;
}

// modules/auth/authz.service.ts — Wave 8
export interface PermissionCheckResult { allowed: boolean }

class AuthzService {
  // Identity with roles/permissions filled in by IAuthorizationProvider.getContext().
  // Never read off user.roles/permissions directly: those are populated only by
  // embedded-claims, so under db-live a claim-reading version reports nothing.
  describeIdentity(user: AuthenticatedUser): Promise<AuthenticatedUser>;
  // Exactly the can() RbacGuard uses, so a UI honouring it matches what the server enforces.
  checkPermission(user: AuthenticatedUser, action: string, subject: string): Promise<PermissionCheckResult>;
}

// modules/auth/dto/check-permission.dto.ts — Wave 8. Split fields, not one "action:subject"
// string, because a subject may itself contain a colon (matches @Permissions() semantics).
class CheckPermissionDto { action: string; subject: string }
```

Routes, REST and GraphQL in lockstep (`AuthController`/`AuthResolver`, `AuthzController`/
`AuthzResolver`):

| REST | GraphQL | Guards | Notes |
|---|---|---|---|
| `GET /auth/me` | `me: AuthenticatedUserType!` | `AuthGuard`, `RbacGuard` | returns `AuthzService.describeIdentity()` |
| `POST /authz/check` | `checkPermission(input): PermissionCheckResultType!` | `AuthGuard`, `RbacGuard` | **no `@Permissions()`** — asking about your own grants is not a privileged action; gating it on one would be circular |

Both are self-introspection routes: they answer only about the caller, and take the identity from
`@CurrentUser()` — never from the request body.

## Change log

| Date | Change | By |
|------|--------|----|
| 2026-09-11 | Seeded from plan.md + implementation.spec.md; DB_PROVIDER set to prisma/drizzle/sequelize/mongoose (Mongoose replaces TypeORM per user) | orchestrator |
| 2026-09-11 | Added optional `roles`/`permissions` to `AuthenticatedUser` (needed by embedded-claims; see §2) | orchestrator |
| 2026-09-11 | `IAuthStrategy.login` now takes `user: AuthenticatedUser` (was `credentials: LoginDto`) — strategies issue sessions for a verified user; the auth service verifies credentials | orchestrator |
| 2026-09-11 | Added `UserRepository` to `JwtStatelessAuthStrategy` constructor (was too thin: `refresh()` could not rebuild email/flags/RBAC claims). `refresh()` now re-resolves identity + claims fresh from the DB | orchestrator |
| 2026-09-11 | Added `assignRole(userId, roleId)` to `UserRepository` (register flow needs to assign the default role; no method existed) — idempotent across all four adapters | orchestrator |
| 2026-09-11 | Added §10 — frozen strategy constructor signatures + factory `inject` arrays | strategy-interfaces-agent |
| 2026-09-14 | `Permission` gains `isSystem`; `PermissionRepository.create` accepts optional `isSystem`. The `is_system` column already existed (migration line 22, `schema.prisma`, `drizzle/schema.ts`) but was not in the entity shape, so adapters dropped it — which let baseline permissions be deleted via the admin API. No migration needed | orchestrator |
| 2026-09-14 | Added `UserRepository.findUserIdsByRole(roleId)` — plan §5.5's `invalidate()` fan-out for role-scoped mutations was unimplementable without a users-of-a-role lookup | orchestrator |
| 2026-09-14 | Added `RoleRepository.detachPermissions(roleId, permissionIds)` — Phase 9 specifies CRUD but the contract had no way to remove a grant (`attachPermissions` is strictly additive) | orchestrator |
| 2026-09-14 | §7 env schema gained an **optional** `CORS_ORIGINS` (comma-separated). Additive only — the frozen strategy/provider enums are unchanged, and leaving it unset must keep booting (CORS stays deny-all) | orchestrator |
| 2026-09-14 | Added §11 — the `modules/auth/` surface, promoting the Wave 5 service signatures that were frozen but never written down, plus Wave 8's `AuthzService`, `CheckPermissionDto`, and the `GET /auth/me` / `POST /authz/check` routes (REST + GraphQL). **Purely additive** — §1–§10 are unchanged, and no frozen interface was touched | orchestrator |
| 2026-09-14 | `SessionRedisAuthStrategy.logout` now interprets a **request-shaped** `sessionRef` as well as the opaque session id. No signature change: `IAuthStrategy.logout(userId, sessionRef: unknown)` is unchanged, and §3 already states the strategy interprets its own transport. Fixes open item S1, where the controller passed the request and the strategy rejected it as non-string, so the session was never invalidated. Contained in `auth-strategies/session-redis/` | orchestrator |
