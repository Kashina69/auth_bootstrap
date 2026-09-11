import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/app-config.service.js';
import type { RefreshTokenRepository } from '../../database/repositories/refresh-token.repository.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import type { AuthResult, IAuthStrategy, RequestMeta } from '../auth-strategy.interface.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { TokenService, type AccessTokenClaims } from './token.service.js';

/**
 * Auth strategy A (default) — CONTRACTS.md §3, plan.md §3.3.
 *
 * A short-lived signed access token (verified by crypto alone, no shared state on the hot
 * path) paired with an opaque rotating refresh token stored only as a SHA-256 hash. The
 * two helper services the constructor builds are deliberately injected nowhere — the
 * module factory that constructs this class is frozen, so they are instantiated here from
 * the very dependencies it was handed.
 */
export class JwtStatelessAuthStrategy implements IAuthStrategy {
  private readonly tokens: TokenService;
  private readonly refreshTokenService: RefreshTokenService;

  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly users: UserRepository,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {
    this.tokens = new TokenService(jwt, config);
    this.refreshTokenService = new RefreshTokenService(refreshTokens);
  }

  /** The caller has already verified the credentials; this only mints the session. */
  async login(user: AuthenticatedUser, meta: RequestMeta): Promise<AuthResult> {
    const issued = this.tokens.issueAccessToken(user);
    const refreshToken = await this.refreshTokenService.issue(user.id, meta);
    return { user, ...issued, refreshToken };
  }

  /**
   * A refresh token is single-use and opaque; after rotating it, the identity and RBAC
   * claims are re-resolved FRESH from the DB so permission changes take effect on the
   * next refresh (plan §3.3), rather than carrying a possibly-stale snapshot forward.
   */
  async refresh(refreshInput: unknown, meta: RequestMeta): Promise<AuthResult> {
    const refreshToken = readRefreshToken(refreshInput);
    const rotated = await this.refreshTokenService.rotate(refreshToken, meta);
    const user = await this.resolveFreshUser(rotated.userId);
    return { user, ...this.tokens.issueAccessToken(user), refreshToken: rotated.refreshToken };
  }

  /** `jwt-stateless` has no server-side session, so logout revokes every refresh token. */
  async logout(userId: string, _sessionRef: unknown): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(userId);
  }

  async validateRequest(req: FastifyRequest): Promise<AuthenticatedUser | null> {
    const accessToken = readBearerToken(req.headers.authorization);
    if (!accessToken) return null;

    try {
      return toAuthenticatedUser(this.tokens.verifyAccessToken(accessToken));
    } catch {
      return null; // expired/forged/wrong-issuer — AuthGuard converts null into a 401
    }
  }

  private async resolveFreshUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.users.findById(userId);
    if (!user || !user.isActive) throw new UnauthorizedException('Account unavailable');
    const { roles, permissions } = await this.users.findRolesAndPermissions(userId);
    return {
      id: user.id,
      email: user.email,
      isActive: user.isActive,
      isEmailVerified: user.isEmailVerified,
      roles,
      permissions,
    };
  }
}

/**
 * `refreshInput` is `unknown` because the transport is strategy-specific: a bare token
 * string, or the `RefreshDto` object (`{ refreshToken }`).
 */
function readRefreshToken(input: unknown): string {
  if (typeof input === 'string') return input;
  if (isRecord(input) && typeof input.refreshToken === 'string') return input.refreshToken;
  throw new UnauthorizedException('Invalid refresh token');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function readBearerToken(header: string | undefined): string | null {
  return header?.match(BEARER_PATTERN)?.[1] ?? null;
}

function toAuthenticatedUser(claims: AccessTokenClaims): AuthenticatedUser {
  return {
    id: claims.sub,
    email: claims.email ?? '',
    isActive: claims.isActive ?? false,
    isEmailVerified: claims.isEmailVerified ?? false,
    ...readVerifiedAuthzClaims(claims),
  };
}

/**
 * Claims decide their own presence: embedded-claims mints roles/permissions into the token,
 * db-live deliberately does not, and an absent claim must stay absent so `rbac-core`
 * default-denies rather than reading an empty array as an authoritative answer.
 */
function readVerifiedAuthzClaims(claims: AccessTokenClaims): {
  roles?: string[];
  permissions?: string[];
} {
  return {
    ...(claims.roles ? { roles: claims.roles } : {}),
    ...(claims.permissions ? { permissions: claims.permissions } : {}),
  };
}
