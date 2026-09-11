
# Implementation Spec — Security-Critical Modules & Multi-ORM Support

**Purpose of this document:** this is the literal, low-ambiguity spec to hand to the model doing the actual coding. It covers only the parts of `plan.md` where a mistake is a security bug, plus the ORM abstraction. Everything here should be implemented **exactly as specified** — do not "simplify" or "optimize" any of the crypto, token, or comparison logic below. Where a rule says "NEVER", that is not a style preference.

Read `plan.md` first for overall architecture (§3 strategy pattern, §4 schema, §7 rbac-core). This document is the zoomed-in, code-level companion for the parts that are easy to get subtly wrong.

---

## 1. Password Hashing (Critical)

**Library:** `argon2` (npm: `argon2`, uses Argon2id).

```ts
// common/security/password.service.ts
import * as argon2 from 'argon2';
import { Injectable } from '@nestjs/common';

@Injectable()
export class PasswordService {
  private readonly hashOptions: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19456,   // 19 MiB — OWASP minimum recommendation for argon2id
    timeCost: 2,
    parallelism: 1,
  };

  async hash(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, this.hashOptions);
  }

  async verify(hash: string, plainPassword: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainPassword);
    } catch {
      // Malformed hash, wrong algorithm, etc. — treat as failed auth, never throw upward.
      return false;
    }
  }
}
```

**Rules:**

- NEVER compare passwords with `===` or any custom string comparison — always use `argon2.verify`, which is constant-time internally.
- NEVER log the plaintext password, even at debug level. Redact it in request-logging interceptors (`password`, `newPassword`, `confirmPassword` fields).
- NEVER store the plaintext password anywhere, even temporarily in a cache/queue payload.
- On login failure, return the **same generic error** ("Invalid email or password") whether the email doesn't exist or the password is wrong. Do not leak which one it was — that's a user-enumeration vulnerability.
- On registration, still hash and validate password strength server-side even if the frontend already validated it. Minimum: 8 chars using a `class-validator` `@Matches` regex; recommend also checking against a common-password blocklist (e.g. top 10k list) if time allows.

---

## 2. JWT Access Token (Critical — applies to `jwt-stateless` auth strategy)

**Algorithm:** `RS256` (asymmetric) is strongly preferred over `HS256` for anything beyond a single-service toy app, because it lets you distribute the **public** key to any service that needs to verify tokens (including, if ever needed, edge/CDN functions) without giving them the ability to *mint* tokens. If time is short, `HS256` with a ≥256-bit random secret is an acceptable fallback for a single-service deployment — but document that choice, don't default to it silently.

```ts
// config/jwt.config.ts
export interface JwtConfig {
  algorithm: 'RS256' | 'HS256';
  accessTokenTtl: string;   // e.g. '15m'
  refreshTokenTtl: string;  // e.g. '30d'
  // RS256:
  privateKey?: string;      // PEM, from env/secret manager, never committed
  publicKey?: string;       // PEM
  // HS256 fallback:
  secret?: string;          // >= 32 random bytes, base64
  issuer: string;
  audience: string;
}
```

```ts
// modules/auth/token.service.ts (used by the jwt-stateless auth strategy — see plan.md §3)
import { JwtService } from '@nestjs/jwt';
import { Injectable } from '@nestjs/common';

export interface AccessTokenClaims {
  sub: string;            // user id
  roles: string[];
  permissions: string[];  // only populated when RBAC_STRATEGY=embedded-claims
  iss: string;
  aud: string;
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService, private readonly config: JwtConfig) {}

  signAccessToken(claims: Omit<AccessTokenClaims, 'iss' | 'aud'>): string {
    return this.jwt.sign(claims, {
      algorithm: this.config.algorithm,
      expiresIn: this.config.accessTokenTtl,
      issuer: this.config.issuer,
      audience: this.config.audience,
      ...(this.config.algorithm === 'RS256'
        ? { privateKey: this.config.privateKey }
        : { secret: this.config.secret }),
    });
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    // Throws on invalid signature, expiry, issuer/audience mismatch — let it throw,
    // the JwtAuthGuard/passport strategy is responsible for converting that into a 401.
    return this.jwt.verify(token, {
      algorithms: [this.config.algorithm],
      issuer: this.config.issuer,
      audience: this.config.audience,
      ...(this.config.algorithm === 'RS256'
        ? { publicKey: this.config.publicKey }
        : { secret: this.config.secret }),
    });
  }
}
```

**Rules:**

- ALWAYS pin `algorithms: [...]` explicitly on verify. NEVER let the library infer the algorithm from the token header — that's the classic "alg confusion" JWT vulnerability (an attacker sends an `HS256` token signed with the *public* RS256 key, treating it as an HMAC secret, if the verifier isn't pinned).
- ALWAYS set and check `issuer` and `audience`.
- Access token TTL should be short: 10–15 minutes. Do not extend this "to reduce refresh calls" — that trades away the main security property of the stateless strategy.
- The access token is **not** an opaque secret you can revoke — treat every claim inside it as something a client can read (JWTs are base64, not encrypted) but not forge (signature-protected). NEVER put a password, secret, or anything the user shouldn't see (e.g. another user's data) in the payload.

---

## 3. Refresh Token Issuance, Rotation & Reuse Detection (Most Critical Flow — read this section twice)

This is the part most likely to be implemented insecurely by a less careful model. Follow it exactly.

**Storage rule:** the raw refresh token is given to the client and NEVER stored anywhere server-side. Only its SHA-256 hash is stored, in the `refresh_tokens` table (see `plan.md` §4).

```ts
// modules/auth/refresh-token.service.ts
import { randomBytes, createHash } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RefreshTokenRepository } from '../../database/repositories/refresh-token.repository';

function generateOpaqueToken(): string {
  return randomBytes(48).toString('base64url'); // 384 bits of entropy
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

@Injectable()
export class RefreshTokenService {
  constructor(private readonly repo: RefreshTokenRepository) {}

  async issue(userId: string, meta: { userAgent: string; ip: string }, familyId?: string) {
    const raw = generateOpaqueToken();
    await this.repo.create({
      userId,
      tokenHash: hashToken(raw),
      familyId: familyId ?? crypto.randomUUID(), // groups all tokens issued from one login
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt: addDays(new Date(), 30),
    });
    return raw; // caller sends this to the client — this is the only time the raw value exists
  }

  /**
   * Validates + ROTATES a refresh token. This is the security-critical function.
   */
  async rotate(rawToken: string, meta: { userAgent: string; ip: string }) {
    const tokenHash = hashToken(rawToken);
    const record = await this.repo.findByHash(tokenHash);

    if (!record) {
      // Token not found at all — either garbage input or already-deleted. Reject.
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.revokedAt) {
      // ⚠️ REUSE DETECTED: this exact token was already used once before (rotation
      // deletes/marks-used the old one — see below). Someone is replaying a stolen
      // refresh token. Nuke the ENTIRE token family, not just this token, and force
      // full re-authentication on every device tied to this login session.
      await this.repo.revokeFamily(record.familyId);
      throw new UnauthorizedException('Refresh token reuse detected — all sessions revoked');
    }

    if (record.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Valid + first use: mark this one used/revoked, issue a brand new one in the same family.
    await this.repo.markRevoked(record.id);
    const newRaw = await this.issue(record.userId, meta, record.familyId);
    return { userId: record.userId, refreshToken: newRaw };
  }

  async revokeAllForUser(userId: string) {
    await this.repo.revokeAllForUser(userId); // "logout everywhere" / admin-forced logout
  }
}
```

**Rules — non-negotiable:**

- NEVER store the raw refresh token. Only the SHA-256 hash. If your DB leaks, raw tokens must not be recoverable from it.
- ALWAYS rotate on every refresh (issue a new token, mark the old one used) — never let the same refresh token be reused indefinitely.
- ALWAYS implement reuse detection: if a token marked "already used" is presented again, that's a signal of token theft — revoke the whole family (every token descended from that original login), not just the one token. This is the single highest-value security control in the whole refresh flow; don't skip it to save time.
- Compare tokens only by looking up the **hash** in the DB (`findByHash`), never by fetching all tokens and comparing in application code — that's both slow and risks non-constant-time comparison bugs. Let the DB index do an exact-match lookup on the hash column.
- Set `httpOnly`, `secure`, `sameSite=strict` (or `lax` if cross-subdomain access is genuinely needed) on the cookie carrying the refresh token, with `path` scoped to `/auth/refresh` only — not the whole site.

---

## 4. RBAC Check — `rbac-core.can()` (Critical, keep this file dependency-free)

Already specified in `plan.md` §7 — repeated here with the required test cases so the implementing model verifies it correctly:

```ts
// rbac-core/can.ts — ZERO imports from NestJS, Prisma, or anything else. Pure functions only.
export interface AuthzContext {
  roles: string[];
  permissions: string[];
}

export function can(ctx: AuthzContext, action: string, subject: string): boolean {
  if (!ctx || !Array.isArray(ctx.permissions)) return false; // deny by default on malformed input
  const perms = new Set(ctx.permissions);
  return perms.has('manage:all') || perms.has(`manage:${subject}`) || perms.has(`${action}:${subject}`);
}
```

**Required unit tests (write these, don't skip):**

1. `can({permissions: ['manage:all']}, 'delete', 'Post')` → `true`
2. `can({permissions: ['manage:Post']}, 'delete', 'Post')` → `true`
3. `can({permissions: ['read:Post']}, 'delete', 'Post')` → `false`
4. `can({permissions: []}, 'read', 'Post')` → `false`
5. `can(undefined as any, 'read', 'Post')` → `false` (must not throw)
6. `can({permissions: ['read:Post']}, 'read', 'post')` → `false` (subject casing must match exactly — document that `subject` strings are case-sensitive and must match the DB `permissions.subject` value verbatim)

**Rule:** this function must **default-deny**. Any ambiguous, malformed, or missing input returns `false`, never `true`. This is the single most important line of code in the whole authorization system — if this function has a bug that ever returns `true` incorrectly, it's a privilege-escalation vulnerability.

---

## 5. Guards (`AuthGuard`, `RbacGuard`) — REST + GraphQL, Strategy-Agnostic

```ts
// common/guards/auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { AUTH_STRATEGY_TOKEN, IS_PUBLIC_KEY } from '../constants';
import type { IAuthStrategy } from '../../auth-strategies/auth-strategy.interface';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_STRATEGY_TOKEN) private readonly authStrategy: IAuthStrategy,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = this.getRequest(context);
    const user = await this.authStrategy.validateRequest(req);
    if (!user) throw new UnauthorizedException();
    req.user = user; // downstream RbacGuard and @CurrentUser() read this
    return true;
  }

  private getRequest(context: ExecutionContext) {
    if (context.getType<'graphql'>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext().req;
    }
    return context.switchToHttp().getRequest();
  }
}
```

```ts
// common/guards/rbac.guard.ts
import { CanActivate, ExecutionContext, Injectable, Inject, ForbiddenException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { can } from '../../rbac-core';
import { AUTHZ_PROVIDER_TOKEN, PERMISSIONS_KEY } from '../constants';
import type { IAuthorizationProvider } from '../../rbac-strategies/authorization-provider.interface';

interface RequiredPermission { action: string; subject: string }

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    @Inject(AUTHZ_PROVIDER_TOKEN) private readonly authz: IAuthorizationProvider,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true; // no @Permissions() decorator = no extra check

    const req = this.getRequest(context);
    if (!req.user) throw new ForbiddenException(); // AuthGuard should have run first — belt & suspenders

    const ctx = await this.authz.getContext(req.user);
    const allowed = required.every((p) => can(ctx, p.action, p.subject));
    if (!allowed) throw new ForbiddenException('Insufficient permissions');
    return true;
  }

  private getRequest(context: ExecutionContext) {
    if (context.getType<'graphql'>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext().req;
    }
    return context.switchToHttp().getRequest();
  }
}
```

**Rules:**

- `AuthGuard` must run before `RbacGuard` in the guard chain (register order matters in Nest — `@UseGuards(AuthGuard, RbacGuard)`).
- NEVER trust `roles`/`permissions` sent by the client in a request body/query — the only source of truth is what `IAuthStrategy.validateRequest()` / `IAuthorizationProvider.getContext()` return, derived from the verified token or a DB lookup. A `@Permissions()`-decorated route must be unreachable without a valid, server-verified identity first.
- Default posture is **deny**: a route with `@Permissions(...)` but no matching permission throws `403`, not a silent pass-through.

---

## 6. Rate Limiting & Brute-Force Lockout (Critical on auth endpoints)

```ts
// modules/auth/auth.controller.ts (excerpt)
import { Throttle } from '@nestjs/throttler';

@Controller('auth')
export class AuthController {
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 requests / 60s / IP
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: FastifyRequest) { /* ... */ }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterDto) { /* ... */ }
}
```

Additionally, layer a **per-account** failed-attempt lockout (IP-based throttling alone is bypassed by botnets / rotating IPs):

```ts
// common/security/login-attempt.service.ts
import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class LoginAttemptService {
  constructor(private readonly redis: Redis) {}

  private key(email: string) {
    return `login-attempts:${email.toLowerCase()}`;
  }

  async recordFailure(email: string): Promise<number> {
    const key = this.key(email);
    const attempts = await this.redis.incr(key);
    if (attempts === 1) await this.redis.expire(key, 15 * 60); // 15 min window
    return attempts;
  }

  async isLocked(email: string): Promise<boolean> {
    const attempts = await this.redis.get(this.key(email));
    return Number(attempts ?? 0) >= 10; // lock after 10 failures in the window
  }

  async clear(email: string): Promise<void> {
    await this.redis.del(this.key(email));
  }
}
```

**Rules:**

- Check `isLocked()` BEFORE verifying the password (cheap check first) — but still return the same generic "invalid credentials" message either way, not "account locked" (that also leaks account existence — decide with the team whether lockout-disclosure is acceptable for your threat model; generic message is the safer default).
- Call `recordFailure()` only on a genuinely wrong password, not on validation errors (malformed email, etc.).
- Call `clear()` on successful login.

---

## 7. CSRF (only when `AUTH_STRATEGY=session-redis`)

```ts
// main.ts (conditional registration)
if (config.AUTH_STRATEGY === 'session-redis') {
  await app.register(fastifyCsrf, { cookieOpts: { signed: true } });
}
```

Not needed under `jwt-stateless` with header-delivered access tokens, since there's no ambient credential (cookie) for a forged cross-site request to ride on. If the refresh token is cookie-delivered under `jwt-stateless` too, apply the same CSRF protection to `/auth/refresh` specifically.

---

## 8. Env/Secrets Validation (fail fast at boot)

```ts
// config/env.schema.ts
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  AUTH_STRATEGY: z.enum(['jwt-stateless', 'session-redis']).default('jwt-stateless'),
  RBAC_STRATEGY: z.enum(['embedded-claims', 'db-live']).default('embedded-claims'),
  DB_PROVIDER: z.enum(['prisma', 'typeorm', 'drizzle', 'sequelize']).default('prisma'),
  DATABASE_URL: z.string().url(),
  JWT_ALGORITHM: z.enum(['RS256', 'HS256']).default('RS256'),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_SECRET: z.string().min(32).optional(),
  REDIS_URL: z.string().url().optional(),
}).superRefine((val, ctx) => {
  if (val.JWT_ALGORITHM === 'RS256' && (!val.JWT_PRIVATE_KEY || !val.JWT_PUBLIC_KEY)) {
    ctx.addIssue({ code: 'custom', message: 'RS256 requires JWT_PRIVATE_KEY and JWT_PUBLIC_KEY' });
  }
  if (val.JWT_ALGORITHM === 'HS256' && !val.JWT_SECRET) {
    ctx.addIssue({ code: 'custom', message: 'HS256 requires JWT_SECRET (min 32 chars)' });
  }
  if ((val.AUTH_STRATEGY === 'session-redis' || val.RBAC_STRATEGY === 'db-live') && !val.REDIS_URL) {
    ctx.addIssue({ code: 'custom', message: 'REDIS_URL is required for session-redis or db-live' });
  }
});
```

Wire via `ConfigModule.forRoot({ validate: (config) => envSchema.parse(config) })`. The app must refuse to boot on a schema failure — never fall back to an insecure default silently (e.g. never auto-generate a throwaway JWT secret at runtime).

---

## 9. Multi-ORM / Multi-DB Support (`DB_PROVIDER` env var — same pattern as §3 of plan.md)

The repository interface is the contract. Every ORM adapter implements it identically; nothing outside `database/` knows which one is active.

```ts
// database/repositories/user.repository.ts — THE CONTRACT
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(data: { email: string; passwordHash: string }): Promise<User>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }>;
}
```

Selection, exactly like the auth/RBAC strategy switch:

```ts
// database/database.module.ts
@Global()
@Module({})
export class DatabaseModule {
  static register(): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: 'USER_REPOSITORY',
          useFactory: (config: AppConfig, client: unknown) => {
            switch (config.DB_PROVIDER) {
              case 'typeorm': return new TypeormUserRepository(client as DataSource);
              case 'drizzle': return new DrizzleUserRepository(client as DrizzleDb);
              case 'sequelize': return new SequelizeUserRepository(client as Sequelize);
              case 'prisma':
              default: return new PrismaUserRepository(client as PrismaClient);
            }
          },
          inject: [AppConfig, 'DB_CLIENT'],
        },
        // repeat identically for ROLE_REPOSITORY, PERMISSION_REPOSITORY, REFRESH_TOKEN_REPOSITORY
      ],
      exports: ['USER_REPOSITORY' /* , ... */],
    };
  }
}
```

### 9.1 Adapter examples (same two methods shown per ORM — replicate the pattern for the rest)

**Prisma**

```ts
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}
  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }
  create(data: { email: string; passwordHash: string }) {
    return this.prisma.user.create({ data: { email: data.email, passwordHash: data.passwordHash } });
  }
}
```

**TypeORM**

```ts
export class TypeormUserRepository implements UserRepository {
  constructor(@InjectRepository(UserEntity) private readonly repo: Repository<UserEntity>) {}
  findByEmail(email: string) {
    return this.repo.findOne({ where: { email } });
  }
  create(data: { email: string; passwordHash: string }) {
    return this.repo.save(this.repo.create({ email: data.email, passwordHash: data.passwordHash }));
  }
}
```

**Drizzle**

```ts
export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: NodePgDatabase) {}
  async findByEmail(email: string) {
    const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0] ?? null;
  }
  async create(data: { email: string; passwordHash: string }) {
    const [row] = await this.db.insert(users).values(data).returning();
    return row;
  }
}
```

**Sequelize**

```ts
export class SequelizeUserRepository implements UserRepository {
  constructor(@InjectModel(UserModel) private readonly model: typeof UserModel) {}
  findByEmail(email: string) {
    return this.model.findOne({ where: { email } });
  }
  create(data: { email: string; passwordHash: string }) {
    return this.model.create(data);
  }
}
```

**Rules:**

- Every adapter must throw/return the same shape on "not found" (`null`, not an ORM-specific exception) — normalize errors at the adapter boundary so `AuthService` never has to know which ORM is underneath.
- Migrations are ORM-specific and NOT unified by this pattern — document that switching `DB_PROVIDER` on an existing database requires running that ORM's own migration tooling against the schema in `plan.md` §4; this pattern only unifies the query/runtime layer, not schema migration tooling.
- Keep raw SQL (parameterized, never string-concatenated) as a documented fallback adapter (`RawSqlUserRepository` via `pg`) for teams that want zero ORM — same interface, same rules.

---

## 10. Summary Checklist for the Implementing Model

Before marking any of this "done", verify:

- [ ] Passwords hashed with argon2id, never compared with `===`.
- [ ] Login failure messages are identical for "no such user" and "wrong password".
- [ ] JWT verify pins `algorithms: [...]`, `issuer`, `audience`.
- [ ] Refresh tokens: raw value never stored, only SHA-256 hash; rotation on every use; reuse triggers full family revocation.
- [ ] `rbac-core.can()` defaults to `false` on any malformed/missing input; unit tests from §4 all pass.
- [ ] `AuthGuard` runs before `RbacGuard`; routes are deny-by-default.
- [ ] Login endpoint is both IP-rate-limited and account-lockout-protected.
- [ ] CSRF protection is on when (and only when) cookie-based sessions are in use.
- [ ] App refuses to boot on missing/invalid secrets — no silent insecure fallback.
- [ ] Every ORM adapter implements the exact same repository interface and normalizes "not found" to `null`.
