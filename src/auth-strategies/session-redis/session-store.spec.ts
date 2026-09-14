import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { SessionRecord } from './session.types.js';
import {
  SESSION_KEY_PREFIX,
  SESSION_TTL_SECONDS,
  createSession,
  deleteSession,
  extendSession,
  generateSessionId,
  readSession,
  sessionExpiresAt,
} from './session-store.js';

const RECORD: SessionRecord = {
  userId: 'user-1',
  user: { id: 'user-1', email: 'user@example.com', isActive: true, isEmailVerified: true },
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-31T00:00:00.000Z',
  device: { userAgent: 'vitest', ip: '127.0.0.1' },
};

/** The key the store must use: a raw session id may never appear in Redis. */
function hashedKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${createHash('sha256').update(sessionId).digest('hex')}`;
}

interface FakeRedis extends Redis {
  entries: Map<string, string>;
  expirations: Array<{ key: string; seconds: number }>;
}

function createFakeRedis(): FakeRedis {
  const entries = new Map<string, string>();
  const expirations: Array<{ key: string; seconds: number }> = [];
  return {
    entries,
    expirations,
    get: (key: string) => Promise.resolve(entries.get(key) ?? null),
    set: (key: string, value: string, _ex: string, seconds: number) => {
      entries.set(key, value);
      expirations.push({ key, seconds });
      return Promise.resolve('OK');
    },
    expire: (key: string, seconds: number) => {
      expirations.push({ key, seconds });
      return Promise.resolve(1);
    },
    del: (key: string) => Promise.resolve(entries.delete(key) ? 1 : 0),
  } as unknown as FakeRedis;
}

describe('generateSessionId', () => {
  it('mints an unguessable, URL-safe id with no padding to escape', () => {
    const id = generateSessionId();

    expect(id).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(id).not.toContain('=');
  });

  it('never repeats across many calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateSessionId()));
    expect(ids.size).toBe(200);
  });
});

describe('createSession', () => {
  it('stores the record under a hashed key, never under the raw session id', async () => {
    const redis = createFakeRedis();
    const sessionId = generateSessionId();

    await createSession(redis, sessionId, RECORD);

    // `not.toContain(sessionId)` would be trivially true here — every key carries the
    // `session:` prefix, so an exact match against a bare id can never hit. The defect worth
    // catching is a key that *contains* the raw id (`session:<id>`), so the check has to be a
    // substring search.
    expect([...redis.entries.keys()].some((key) => key.includes(sessionId))).toBe(false);
    expect(redis.entries.get(hashedKey(sessionId))).toBe(JSON.stringify(RECORD));
  });

  it('issues the record and its TTL in one command, so no session can exist without an expiry', async () => {
    const redis = createFakeRedis();

    await createSession(redis, 'sid', RECORD);

    expect(redis.expirations).toEqual([{ key: hashedKey('sid'), seconds: SESSION_TTL_SECONDS }]);
  });
});

describe('readSession', () => {
  it('round-trips a stored session', async () => {
    const redis = createFakeRedis();
    await createSession(redis, 'sid', RECORD);

    expect(await readSession(redis, 'sid')).toEqual(RECORD);
  });

  it('returns null for an unknown session rather than throwing', async () => {
    expect(await readSession(createFakeRedis(), 'never-issued')).toBeNull();
  });

  it('treats a corrupt blob as no session, not a crash and not a user', async () => {
    const redis = createFakeRedis();
    redis.entries.set(hashedKey('sid'), '{not json');

    expect(await readSession(redis, 'sid')).toBeNull();
  });

  it('rejects a well-formed JSON blob that is not a session record', async () => {
    const redis = createFakeRedis();
    redis.entries.set(hashedKey('sid'), JSON.stringify({ userId: 'user-1' }));

    expect(await readSession(redis, 'sid')).toBeNull();
  });
});

describe('extendSession', () => {
  it('moves only the TTL, leaving the stored blob untouched', async () => {
    const redis = createFakeRedis();
    await createSession(redis, 'sid', RECORD);
    redis.expirations.length = 0;

    await extendSession(redis, 'sid');

    expect(redis.expirations).toEqual([{ key: hashedKey('sid'), seconds: SESSION_TTL_SECONDS }]);
    expect(redis.entries.get(hashedKey('sid'))).toBe(JSON.stringify(RECORD));
  });
});

describe('deleteSession', () => {
  it('removes exactly the addressed session', async () => {
    const redis = createFakeRedis();
    await createSession(redis, 'sid-1', RECORD);
    await createSession(redis, 'sid-2', RECORD);

    await deleteSession(redis, 'sid-1');

    expect(await readSession(redis, 'sid-1')).toBeNull();
    expect(await readSession(redis, 'sid-2')).toEqual(RECORD);
  });
});

describe('sessionExpiresAt', () => {
  it('lands one session TTL in the future, as an ISO-8601 instant', () => {
    const before = Date.now();
    const expiresAt = Date.parse(sessionExpiresAt());

    expect(expiresAt).toBeGreaterThanOrEqual(before + SESSION_TTL_SECONDS * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_SECONDS * 1000);
  });
});
