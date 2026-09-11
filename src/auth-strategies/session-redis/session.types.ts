import type { AuthenticatedUser } from '../../rbac-core/index.js';
import type { RequestMeta } from '../auth-strategy.interface.js';

/**
 * The server-side session blob (plan.md §3.3).
 *
 * The full `user` snapshot is stored, not just the id, because `validateRequest` must
 * rebuild `request.user` and the strategy's frozen constructor (CONTRACTS.md §10) gets
 * no `UserRepository` to look it up with. Under `embedded-claims` the snapshot carries
 * the roles/permissions resolved at login (CONTRACTS.md §2); under `db-live` they stay
 * absent so `RbacGuard` resolves them live on each request.
 */
export interface SessionRecord {
  /** Owner of the session — `logout` refuses to revoke a session belonging to anyone else. */
  userId: string;
  user: AuthenticatedUser;
  issuedAt: string; // ISO-8601
  expiresAt: string; // ISO-8601
  device: RequestMeta;
}

/** A freshly minted session: the id that travels to the client, and what is stored. */
export interface IssuedSession {
  sessionId: string;
  record: SessionRecord;
}

/**
 * The cookie contract the auth service (`modules/auth/`) must apply when it attaches the
 * session id to the response. `httpOnly` keeps the id out of reach of client JS and
 * `sameSite=strict` is what makes the CSRF token registered in `main.ts` meaningful
 * (implementation.spec.md §7).
 */
export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
}
