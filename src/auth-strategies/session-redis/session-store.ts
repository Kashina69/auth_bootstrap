import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SessionRecord } from './session.types.js';

/** Namespaced so session keys can be scanned or flushed without touching other Redis users. */
export const SESSION_KEY_PREFIX = 'session:';

/**
 * Mirrors `DEFAULT_JWT_REFRESH_TOKEN_TTL` ('30d'): a session is the long-lived credential
 * of this strategy, kept alive by sliding expiration on every refresh.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const SESSION_ID_BYTES = 48;

export function generateSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

export function sessionExpiresAt(): string {
  return new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
}

/** `SET ... EX` issues the record and its TTL in one atomic command — there is no window
 * in which a session exists without an expiry. */
export async function createSession(
  redis: Redis,
  sessionId: string,
  record: SessionRecord,
): Promise<void> {
  await redis.set(sessionKey(sessionId), JSON.stringify(record), 'EX', SESSION_TTL_SECONDS);
}

export async function readSession(redis: Redis, sessionId: string): Promise<SessionRecord | null> {
  return parseSessionRecord(await redis.get(sessionKey(sessionId)));
}

/** Sliding expiration: the stored blob is untouched, only its Redis TTL moves. */
export async function extendSession(redis: Redis, sessionId: string): Promise<void> {
  await redis.expire(sessionKey(sessionId), SESSION_TTL_SECONDS);
}

export async function deleteSession(redis: Redis, sessionId: string): Promise<void> {
  await redis.del(sessionKey(sessionId));
}

/**
 * The key holds the SHA-256 of the session id, never the id itself — the same
 * "a raw credential is never at rest" rule refresh tokens follow (CONTRACTS.md §9), so a
 * leaked Redis dump yields no usable session ids.
 */
function sessionKey(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `${SESSION_KEY_PREFIX}${digest}`;
}

/** A corrupt or truncated blob is an invalid session, never a crash and never a user. */
function parseSessionRecord(raw: string | null): SessionRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSessionRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionRecord>;
  return typeof candidate.userId === 'string' && typeof candidate.user?.id === 'string';
}
