import type { JwtService, JwtSignOptions, JwtVerifyOptions } from '@nestjs/jwt';
import type { AppConfig } from '../../config/app-config.service.js';
import {
  DEFAULT_JWT_ACCESS_TOKEN_TTL,
  DEFAULT_JWT_AUDIENCE,
  DEFAULT_JWT_ISSUER,
} from '../../config/constants.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';

/** The claims this service mints and accepts (implementation.spec.md §2). */
export interface AccessTokenClaims {
  sub: string; // user id
  email: string;
  isActive: boolean;
  isEmailVerified: boolean;
  // Present only under RBAC_STRATEGY=embedded-claims — db-live must never bake in a
  // snapshot that would go stale before the token expires (plan.md §3.3).
  roles?: string[];
  permissions?: string[];
  iss?: string;
  aud?: string;
  exp?: number;
  iat?: number;
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresAt: string; // ISO-8601, read back off the token so the two cannot drift
}

/**
 * Signs and verifies the short-lived access token for the `jwt-stateless` strategy.
 *
 * Deliberately not an `@Injectable()` provider: the DI switch in `auth-strategies.module.ts`
 * is frozen and constructs the strategy with `new`, so the strategy builds this from the
 * same `JwtService`/`AppConfig` it was handed.
 */
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  issueAccessToken(user: AuthenticatedUser): IssuedAccessToken {
    const accessToken = this.signAccessToken(user);
    return { accessToken, expiresAt: readExpiry(accessToken, this.jwt) };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return this.jwt.verify<AccessTokenClaims>(token, this.verifyOptions());
  }

  private signAccessToken(user: AuthenticatedUser): string {
    return this.jwt.sign(this.buildClaims(user), this.signOptions());
  }

  private buildClaims(user: AuthenticatedUser): AccessTokenClaims {
    return {
      sub: user.id,
      email: user.email,
      isActive: user.isActive,
      isEmailVerified: user.isEmailVerified,
      ...this.embeddedAuthzClaims(user),
    };
  }

  private embeddedAuthzClaims(user: AuthenticatedUser): {
    roles?: string[];
    permissions?: string[];
  } {
    if (this.config.RBAC_STRATEGY !== 'embedded-claims') return {};
    return { roles: user.roles ?? [], permissions: user.permissions ?? [] };
  }

  private signOptions(): JwtSignOptions {
    return {
      algorithm: this.config.JWT_ALGORITHM,
      expiresIn: DEFAULT_JWT_ACCESS_TOKEN_TTL,
      issuer: DEFAULT_JWT_ISSUER,
      audience: DEFAULT_JWT_AUDIENCE,
      ...this.signingKey(),
    };
  }

  /** Pinning `algorithms` + `issuer` + `audience` is the alg-confusion defense (§2 rules). */
  private verifyOptions(): JwtVerifyOptions {
    return {
      algorithms: [this.config.JWT_ALGORITHM],
      issuer: DEFAULT_JWT_ISSUER,
      audience: DEFAULT_JWT_AUDIENCE,
      ...this.verifyingKey(),
    };
  }

  private signingKey(): Pick<JwtSignOptions, 'privateKey' | 'secret'> {
    return this.config.JWT_ALGORITHM === 'RS256'
      ? { privateKey: this.config.JWT_PRIVATE_KEY }
      : { secret: this.config.JWT_SECRET };
  }

  private verifyingKey(): Pick<JwtVerifyOptions, 'publicKey' | 'secret'> {
    return this.config.JWT_ALGORITHM === 'RS256'
      ? { publicKey: this.config.JWT_PUBLIC_KEY }
      : { secret: this.config.JWT_SECRET };
  }
}

function readExpiry(accessToken: string, jwt: JwtService): string {
  const claims = jwt.decode<AccessTokenClaims>(accessToken);
  if (!claims?.exp) throw new Error('Signed access token is missing an exp claim');
  return new Date(claims.exp * 1000).toISOString();
}
