import { UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/app-config.service.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import type { AuthResult, IAuthStrategy, RequestMeta } from '../auth-strategy.interface.js';
import { readSessionId } from './session-cookie.js';
import {
  createSession,
  deleteSession,
  extendSession,
  generateSessionId,
  readSession,
  sessionExpiresAt,
} from './session-store.js';
import type { IssuedSession, SessionRecord } from './session.types.js';

/**
 * Auth strategy B — CONTRACTS.md §3, plan.md §3.3.
 *
 * The client holds nothing but an opaque, unguessable session id in an `httpOnly`,
 * `sameSite=strict` cookie; the session's state (user snapshot, device, expiry) lives in
 * Redis. Logout/ban is therefore a single key deletion, no claim is ever exposed to
 * client-side JS, and every authenticated request costs one Redis round trip.
 *
 * **Cookie delivery — KNOWN GAP (open item S2):** `IAuthStrategy.login` receives no response
 * object, so the session id travels back to the caller inside `AuthResult.refreshToken`;
 * `createSessionCookieOptions()` is the single source of truth for the mandatory flags
 * (`httpOnly`, `secure` in production, `sameSite=strict`, `path=/`, `maxAge` matching the
 * Redis TTL). **Nothing attaches that cookie yet** — no caller has a response handle at the
 * point it holds the id — so under this strategy the credential currently reaches the client
 * only as an `AuthResult` field, and cookie-only refresh does not work. Closing it is a
 * contract decision (how a strategy delivers a response artifact), not a controller patch;
 * see `MEMORY.md`. The id is never logged by this class.
 */
export class SessionRedisAuthStrategy implements IAuthStrategy {
  constructor(
    private readonly redis: Redis,
    private readonly config: AppConfig,
  ) {}

  async login(user: AuthenticatedUser, meta: RequestMeta): Promise<AuthResult> {
    const session = issueSession(user, meta);
    await createSession(this.redis, session.sessionId, session.record);
    return toAuthResult(session);
  }

  async refresh(refreshInput: unknown, meta: RequestMeta): Promise<AuthResult> {
    const sessionId = requireSessionId(refreshInput);
    const record = await readSession(this.redis, sessionId);
    if (!record) throw invalidSession();
    await extendSession(this.redis, sessionId);
    return toAuthResult({ sessionId, record: refreshDeviceAndExpiry(record, meta) });
  }

  async logout(userId: string, sessionRef: unknown): Promise<void> {
    const sessionId = resolveSessionId(sessionRef);
    if (!sessionId) return;
    const record = await readSession(this.redis, sessionId);
    if (record && record.userId !== userId) return;
    await deleteSession(this.redis, sessionId);
  }

  /**
   * The only path from a request to a user is cookie → Redis lookup. A user id supplied
   * by the client is never read, let alone trusted.
   */
  async validateRequest(req: FastifyRequest): Promise<AuthenticatedUser | null> {
    try {
      const sessionId = readSessionId(req);
      if (!sessionId) return null;
      const record = await readSession(this.redis, sessionId);
      return record?.user ?? null;
    } catch {
      // Never throw out of the guard: a Redis outage or malformed cookie fails closed
      // (unauthenticated), it does not turn a protected route into a 500.
      return null;
    }
  }
}

function issueSession(user: AuthenticatedUser, meta: RequestMeta): IssuedSession {
  return {
    sessionId: generateSessionId(),
    record: {
      userId: user.id,
      user,
      issuedAt: new Date().toISOString(),
      expiresAt: sessionExpiresAt(),
      device: meta,
    },
  };
}

function toAuthResult(session: IssuedSession): AuthResult {
  return {
    user: session.record.user,
    expiresAt: session.record.expiresAt,
    // Carries the opaque session id: the transport for the cookie the auth service sets.
    refreshToken: session.sessionId,
  };
}

function refreshDeviceAndExpiry(record: SessionRecord, meta: RequestMeta): SessionRecord {
  return { ...record, device: meta, expiresAt: sessionExpiresAt() };
}

function requireSessionId(sessionRef: unknown): string {
  const sessionId = resolveSessionId(sessionRef);
  if (!sessionId) throw invalidSession();
  return sessionId;
}

/**
 * The session id as it reaches this strategy, in either of the two shapes the frozen
 * `IAuthStrategy.logout(userId, sessionRef: unknown)` contract permits: the opaque id itself
 * (what `login`/`refresh` return in `AuthResult.refreshToken`), or the platform request it
 * rides on. The request case is not a convenience — the auth controller is deliberately
 * transport-agnostic and passes the raw request through, so reading the cookie here is what
 * keeps `logout` from silently invalidating nothing. Naming the cookie in the controller
 * instead would hard-wire this one concrete strategy into a strategy-agnostic layer.
 */
function resolveSessionId(sessionRef: unknown): string | null {
  if (isSessionRef(sessionRef)) return sessionRef;
  if (isRequestLike(sessionRef)) return readSessionId(sessionRef);
  return null;
}

function isSessionRef(sessionRef: unknown): sessionRef is string {
  return typeof sessionRef === 'string' && sessionRef.length > 0;
}

function isRequestLike(sessionRef: unknown): sessionRef is FastifyRequest {
  return typeof sessionRef === 'object' && sessionRef !== null && 'headers' in sessionRef;
}

/** Identical message for "no such session" and "malformed ref" — nothing to enumerate. */
function invalidSession(): UnauthorizedException {
  return new UnauthorizedException('Session is invalid or expired');
}
