import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../rbac-core/index.js';

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

/**
 * The strategy issues/validates the session for an already-authenticated user.
 * Credential verification (user lookup + password check) happens in the auth service
 * (`modules/auth/`), which passes the verified `user` here — so the strategies stay free
 * of any `UserRepository`/`PasswordService` dependency, matching their frozen
 * constructor signatures (CONTRACTS.md §10).
 */
export interface IAuthStrategy {
  login(user: AuthenticatedUser, meta: RequestMeta): Promise<AuthResult>;
  refresh(refreshInput: unknown, meta: RequestMeta): Promise<AuthResult>;
  logout(userId: string, sessionRef: unknown): Promise<void>;
  validateRequest(req: FastifyRequest): Promise<AuthenticatedUser | null>; // used by AuthGuard
}
