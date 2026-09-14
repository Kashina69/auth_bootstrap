import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  deleteSession,
  extendSession,
  generateSessionId,
  readSession,
  SESSION_KEY_PREFIX,
  SESSION_TTL_SECONDS,
} from '../../src/auth-strategies/session-redis/session-store.js';
import type { SessionRecord } from '../../src/auth-strategies/session-redis/session.types.js';
import { allSuiteKeys, clearRedisKeys, createRedisClient } from './support/live-services.js';

const RECORD: SessionRecord = {
  userId: 'ab6f4f7e-0000-4000-8000-000000000001',
  user: {
    id: 'ab6f4f7e-0000-4000-8000-000000000001',
    email: 'store@example.com',
    isActive: true,
    isEmailVerified: true,
    roles: [],
    permissions: [],
  },
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-31T00:00:00.000Z',
  device: { userAgent: 'vitest', ip: '127.0.0.1' },
};

/** The key the store must actually use — recomputed here, never imported from the store. */
function hashedKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${createHash('sha256').update(sessionId).digest('hex')}`;
}

describe('session-store over real Redis', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = createRedisClient();
  });

  beforeEach(async () => {
    await clearRedisKeys(redis);
  });

  afterAll(async () => {
    await clearRedisKeys(redis);
    await redis.quit();
  });

  it('issues the session and its expiry in one command, so the TTL is armed from the start', async () => {
    const sessionId = generateSessionId();
    await createSession(redis, sessionId, RECORD);

    // A key with no expiry is the failure this asserts against: `ttl` returns -1 for one.
    const ttl = await redis.ttl(hashedKey(sessionId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
  });

  it('keeps the raw session id out of Redis — only its SHA-256 is a key', async () => {
    const sessionId = generateSessionId();
    await createSession(redis, sessionId, RECORD);

    const keys = await allSuiteKeys(redis);
    // `includes`, not `toContain`: the defect is a key of the form `session:<raw id>`, which
    // an exact-match check would miss because every key carries the prefix.
    expect(keys.some((key) => key.includes(sessionId))).toBe(false);
    expect(keys).toContain(hashedKey(sessionId));
  });

  it('mutation check: a session keyed by the raw id is caught', async () => {
    // Force the defect the assertion above exists to catch, and confirm it is detected.
    const leaked = generateSessionId();
    await redis.set(`${SESSION_KEY_PREFIX}${leaked}`, JSON.stringify(RECORD));

    expect((await allSuiteKeys(redis)).some((key) => key.includes(leaked))).toBe(true);
  });

  it('mutation check: a key written without EX reads ttl -1, so the armed-TTL assertion bites', async () => {
    const bare = generateSessionId();
    await redis.set(hashedKey(bare), JSON.stringify(RECORD));
    expect(await redis.ttl(hashedKey(bare))).toBe(-1);

    const sessionId = generateSessionId();
    await createSession(redis, sessionId, RECORD);
    expect(await redis.ttl(hashedKey(sessionId))).toBeGreaterThan(0);
  });

  it('round-trips the stored record through Redis', async () => {
    const sessionId = generateSessionId();
    await createSession(redis, sessionId, RECORD);

    await expect(readSession(redis, sessionId)).resolves.toEqual(RECORD);
  });

  it('reads a missing session as null rather than throwing', async () => {
    await expect(readSession(redis, generateSessionId())).resolves.toBeNull();
  });

  it('treats a corrupt blob as an invalid session, never as a user', async () => {
    const sessionId = generateSessionId();
    await redis.set(hashedKey(sessionId), '{not json');

    await expect(readSession(redis, sessionId)).resolves.toBeNull();
  });

  it('slides the expiry forward on refresh without rewriting the blob', async () => {
    const sessionId = generateSessionId();
    await createSession(redis, sessionId, RECORD);
    // Age the session so the extension is observable: near expiry, not at the full TTL.
    await redis.expire(hashedKey(sessionId), 60);
    expect(await redis.ttl(hashedKey(sessionId))).toBeLessThanOrEqual(60);

    await extendSession(redis, sessionId);

    const ttl = await redis.ttl(hashedKey(sessionId));
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
    // Sliding expiration moves the TTL only — the record's own expiresAt is not rewritten.
    await expect(readSession(redis, sessionId)).resolves.toEqual(RECORD);
  });

  it('removes the key on logout so a stolen id is worthless afterwards', async () => {
    const sessionId = generateSessionId();
    await createSession(redis, sessionId, RECORD);

    await deleteSession(redis, sessionId);

    expect(await redis.exists(hashedKey(sessionId))).toBe(0);
    await expect(readSession(redis, sessionId)).resolves.toBeNull();
  });

  it('does not resurrect a session when extendSession runs against a deleted key', async () => {
    const sessionId = generateSessionId();
    await createSession(redis, sessionId, RECORD);
    await deleteSession(redis, sessionId);

    await extendSession(redis, sessionId);

    expect(await redis.exists(hashedKey(sessionId))).toBe(0);
  });
});
