import type { ThrottlerStorage } from '@nestjs/throttler';

/**
 * `@nestjs/throttler` does not re-export `ThrottlerStorageRecord` from its entry point, so the
 * shape is restated here. `ThrottlerStorage` is structural, so satisfying it needs the fields,
 * not the original type.
 */
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * A reset-able in-memory `ThrottlerStorage` for the e2e suite.
 *
 * The auth routes carry real per-IP ceilings (register 3, login 5, refresh 5 per 60s — spec §6),
 * so a suite that registers a user per test would exhaust them and start asserting 429s instead
 * of the behaviour it means to check. Swapping the storage keeps the guard, the `@Throttle()`
 * metadata and its `limit`/`ttl` arithmetic all in play — only the counter's lifetime is under
 * the test's control, so the ceiling can still be asserted deliberately (see the throttling
 * describe block) and cleared between tests.
 */
export interface ResettableThrottlerStorage extends ThrottlerStorage {
  reset(): void;
}

interface Counter {
  totalHits: number;
  expiresAt: number;
  blockedUntil: number;
}

export function createTestThrottlerStorage(): ResettableThrottlerStorage {
  const counters = new Map<string, Counter>();

  return {
    reset(): void {
      counters.clear();
    },

    async increment(
      key: string,
      ttl: number,
      limit: number,
      blockDuration: number,
      throttlerName: string,
    ): Promise<ThrottlerStorageRecord> {
      const now = Date.now();
      const composite = `${throttlerName}:${key}`;
      const existing = counters.get(composite);
      const counter: Counter =
        existing && existing.expiresAt > now
          ? existing
          : { totalHits: 0, expiresAt: now + ttl, blockedUntil: 0 };

      counter.totalHits += 1;
      const isBlocked = counter.totalHits > limit;
      if (isBlocked && counter.blockedUntil <= now) counter.blockedUntil = now + blockDuration;
      counters.set(composite, counter);

      return {
        totalHits: counter.totalHits,
        timeToExpire: Math.max(0, Math.ceil((counter.expiresAt - now) / 1000)),
        isBlocked,
        timeToBlockExpire: Math.max(0, Math.ceil((counter.blockedUntil - now) / 1000)),
      };
    },
  };
}
