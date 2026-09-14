import { vi } from 'vitest';

/**
 * The in-memory session store standing in for ioredis. `SessionRedisAuthStrategy` (and
 * `db-live`'s cache) would otherwise dial a real Redis, which the e2e suite deliberately
 * does not have — it substitutes the persistence boundary and runs the real app above it.
 *
 * This lives in a setup file, not in `harness.ts`, for two reasons: `vi.mock` is hoisted to
 * the top of the file that calls it, so a call inside an *imported* module is registered
 * after the importing spec's own imports have already been evaluated; and it must apply to
 * the e2e config only. The integration suite imports the same harness against a real Redis
 * and must not inherit this mock.
 */
vi.mock('ioredis', () => {
  class Redis {
    private readonly entries = new Map<string, string>();
    /** A real ioredis client is an EventEmitter; `LoginAttemptService` attaches an error
     * listener, so the stand-in has to accept one or the harness dies constructing it. */
    on(): this {
      return this;
    }
    async get(key: string): Promise<string | null> {
      return this.entries.get(key) ?? null;
    }
    async set(key: string, value: string): Promise<'OK'> {
      this.entries.set(key, value);
      return 'OK';
    }
    async expire(): Promise<number> {
      return 1;
    }
    async del(key: string): Promise<number> {
      return this.entries.delete(key) ? 1 : 0;
    }
    /** Called by `LoginAttemptService.onModuleDestroy` when the app closes. */
    async quit(): Promise<'OK'> {
      this.entries.clear();
      return 'OK';
    }
  }
  return { Redis, default: Redis };
});
