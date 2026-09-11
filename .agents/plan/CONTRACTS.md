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
  login(credentials: LoginDto, meta: RequestMeta): Promise<AuthResult>;
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
  findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }>;
}

export interface RoleRepository {
  findById(id: string): Promise<Role | null>;
  findByName(name: string): Promise<Role | null>;
  findAll(): Promise<Role[]>;
  create(data: { name: string; description?: string; isSystem?: boolean }): Promise<Role>;
  attachPermissions(roleId: string, permissionIds: string[]): Promise<void>;
  listPermissions(roleId: string): Promise<Permission[]>;
  delete(id: string): Promise<void>;
}

export interface PermissionRepository {
  findById(id: string): Promise<Permission | null>;
  findByName(name: string): Promise<Permission | null>;
  findAll(): Promise<Permission[]>;
  create(data: { action: string; subject: string; description?: string }): Promise<Permission>;
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

## Change log

| Date | Change | By |
|------|--------|----|
| 2026-09-11 | Seeded from plan.md + implementation.spec.md; DB_PROVIDER set to prisma/drizzle/sequelize/mongoose (Mongoose replaces TypeORM per user) | orchestrator |
