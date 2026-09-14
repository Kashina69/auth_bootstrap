import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/app-config.service.js';
import { LoginAttemptService } from './login-attempt.service.js';

const EMAIL = 'User@Example.com';
const KEY = 'login-attempts:user@example.com';

/**
 * Every other test in this file hands the service a fake through the `createClient` seam, so
 * the real one — the listener and the shutdown — would never execute. This stand-in for the
 * `ioredis` module lets the real `createClient` run against a client that records what was
 * done to it. `vi.hoisted` is required: `vi.mock` is lifted above the imports, so a plain
 * `const` would still be in its temporal dead zone when the factory first runs.
 */
const { createdClients } = vi.hoisted(() => ({ createdClients: [] as FakeRedisClient[] }));

interface FakeRedisClient {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  quitCalls: number;
  emit(event: string, ...args: unknown[]): void;
}

vi.mock('ioredis', () => {
  class Redis implements FakeRedisClient {
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    quitCalls = 0;

    constructor() {
      createdClients.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(handler);
      this.listeners.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.listeners.get(event) ?? []) handler(...args);
    }

    async quit(): Promise<'OK'> {
      this.quitCalls += 1;
      return 'OK';
    }
  }
  return { Redis, default: Redis };
});

/** The three commands the service issues, over a Map instead of a socket. */
function createFakeRedis() {
  const counts = new Map<string, number>();
  const expirations: Array<{ key: string; seconds: number }> = [];
  const redis = {
    incr: (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve(next);
    },
    expire: (key: string, seconds: number) => {
      expirations.push({ key, seconds });
      return Promise.resolve(1);
    },
    get: (key: string) => Promise.resolve(counts.get(key)?.toString() ?? null),
    del: (key: string) => {
      counts.delete(key);
      return Promise.resolve(1);
    },
  };
  return { counts, expirations, redis: redis as unknown as Redis };
}

/** Hands the service a fake (or nothing at all) instead of dialing a real connection. */
function createService(redis: Redis | null): LoginAttemptService {
  class TestService extends LoginAttemptService {
    protected override createClient(): Redis {
      return redis as Redis;
    }
  }
  const config = { REDIS_URL: redis === null ? undefined : 'redis://localhost:6379' } as AppConfig;
  return new TestService(config);
}

describe('LoginAttemptService', () => {
  it('counts a failure per address, keyed lowercase, and starts the 15-minute window once', async () => {
    const { counts, expirations, redis } = createFakeRedis();
    const attempts = createService(redis);

    await attempts.recordFailure(EMAIL);
    await attempts.recordFailure('USER@example.com');

    expect(counts.get(KEY)).toBe(2);
    expect(expirations).toEqual([{ key: KEY, seconds: 900 }]);
  });

  it('is not locked below ten failures and locked at ten', async () => {
    const { redis } = createFakeRedis();
    const attempts = createService(redis);

    for (let i = 0; i < 9; i++) await attempts.recordFailure(EMAIL);
    await expect(attempts.isLocked(EMAIL)).resolves.toBe(false);

    await attempts.recordFailure(EMAIL);
    await expect(attempts.isLocked(EMAIL)).resolves.toBe(true);
  });

  it('clears the counter so a successful login resets the window', async () => {
    const { counts, redis } = createFakeRedis();
    const attempts = createService(redis);

    for (let i = 0; i < 10; i++) await attempts.recordFailure(EMAIL);
    await attempts.clear(EMAIL);

    await expect(attempts.isLocked(EMAIL)).resolves.toBe(false);
    expect(counts.has(KEY)).toBe(false);
  });

  it('is inactive without REDIS_URL: no client, no lockout, one warning at boot', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const attempts = createService(null);

    attempts.onModuleInit();
    await expect(attempts.recordFailure(EMAIL)).resolves.toBe(0);
    await expect(attempts.isLocked(EMAIL)).resolves.toBe(false);
    await expect(attempts.clear(EMAIL)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('INACTIVE');
    warn.mockRestore();
  });

  it('fails open when Redis answers with an error', async () => {
    const refusing = {
      incr: () => Promise.reject(new Error('connection refused')),
      get: () => Promise.reject(new Error('connection refused')),
      del: () => Promise.reject(new Error('connection refused')),
    } as unknown as Redis;
    const attempts = createService(refusing);

    await expect(attempts.recordFailure(EMAIL)).resolves.toBe(0);
    await expect(attempts.isLocked(EMAIL)).resolves.toBe(false);
    await expect(attempts.clear(EMAIL)).resolves.toBeUndefined();
  });

  describe('the real client — failure channel and shutdown', () => {
    /** Uses the service's own `createClient`, unlike every test above. */
    function createServiceWithRealClient(redisUrl: string | undefined): LoginAttemptService {
      return new LoginAttemptService({ REDIS_URL: redisUrl } as AppConfig);
    }

    it('attaches an error listener, so an unreachable Redis is not an unhandled emitter error', () => {
      createdClients.length = 0;
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      createServiceWithRealClient('redis://localhost:6379');
      const client = createdClients.at(-1)!;

      // The listener is the whole point: ioredis logs an "Unhandled error event" when an
      // `error` event has no subscriber, and `withRedis` cannot catch this channel — it only
      // catches failures of individual commands.
      expect(client.listeners.get('error')).toHaveLength(1);

      client.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failing open'));
      warn.mockRestore();
    });

    it('quits its client on shutdown, so the app can actually exit', async () => {
      createdClients.length = 0;
      const service = createServiceWithRealClient('redis://localhost:6379');
      const client = createdClients.at(-1)!;

      await service.onModuleDestroy();

      expect(client.quitCalls).toBe(1);
    });

    it('shuts down cleanly when there is no client at all', async () => {
      const service = createServiceWithRealClient(undefined);

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
