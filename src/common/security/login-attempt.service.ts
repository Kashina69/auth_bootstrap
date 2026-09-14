import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.service.js';

/** Failures inside one window that lock the account (spec §6). */
const LOCK_THRESHOLD = 10;

/** How long a failure count lives: a lock lifts on its own 15 minutes after the last failure. */
const WINDOW_SECONDS = 15 * 60;

/**
 * Per-account brute-force lockout (spec §6): IP throttling alone is bypassed by rotating
 * IPs, so failures are counted against the address being attacked. The counter lives in
 * Redis because every instance must see the same one.
 *
 * The default pairing (`jwt-stateless` + `embedded-claims`) has no Redis, and a lockout
 * layer is defense in depth — it must never be the reason a login fails. So the service
 * owns its client and, when `REDIS_URL` is unset, degrades to a no-op that says so once
 * at boot, rather than injecting the strategy modules' throwing stub. It builds its own
 * client because neither `AuthStrategiesModule` nor `RbacStrategiesModule` exports
 * `REDIS_CLIENT`, so the token is not injectable from the feature modules.
 */
@Injectable()
export class LoginAttemptService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoginAttemptService.name);
  private readonly redis: Redis | null;

  constructor(config: AppConfig) {
    this.redis = config.REDIS_URL === undefined ? null : this.createClient(config.REDIS_URL);
  }

  /**
   * The one place a connection is opened — the specs subclass this to hand in a fake.
   *
   * The `error` listener is not optional. `ioredis` is an EventEmitter, and an `error` event
   * with no listener is logged by ioredis as an "Unhandled error event" and would otherwise be
   * an unhandled emitter error. `withRedis` catches failures of individual *commands*, but a
   * connection-level failure is a different channel: when Redis is unreachable — precisely the
   * fail-open case this service is built around — every logged error came from here.
   */
  protected createClient(url: string): Redis {
    const client = new Redis(url);
    client.on('error', (error: Error) => {
      this.logger.warn(`Redis error for the login lockout — failing open: ${error.message}`);
    });
    return client;
  }

  onModuleInit(): void {
    if (this.redis === null) {
      this.logger.warn(
        'Per-account login lockout is INACTIVE: REDIS_URL is not set, so login is rate-limited per IP only.',
      );
    }
  }

  /**
   * Without this the client outlives the app: `ioredis` keeps a socket and a reconnect timer
   * open, so the process does not exit after `app.close()` and `main.ts`'s
   * `enableShutdownHooks()` tears down with the connection still up.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.redis !== null) await this.redis.quit();
  }

  async recordFailure(email: string): Promise<number> {
    return this.withRedis(async (redis) => {
      const key = this.key(email);
      const attempts = await redis.incr(key);
      if (attempts === 1) await redis.expire(key, WINDOW_SECONDS);
      return attempts;
    }, 0);
  }

  async isLocked(email: string): Promise<boolean> {
    return this.withRedis(async (redis) => {
      const attempts = Number((await redis.get(this.key(email))) ?? 0);
      return attempts >= LOCK_THRESHOLD;
    }, false);
  }

  async clear(email: string): Promise<void> {
    await this.withRedis(async (redis) => {
      await redis.del(this.key(email));
    }, undefined);
  }

  /**
   * Runs one operation against Redis, answering `fallback` if Redis is absent or the call
   * fails: an unreachable Redis must fail OPEN, since locking every account out of login
   * is worse than the brute-force lockout it would be protecting against.
   */
  private async withRedis<T>(operation: (redis: Redis) => Promise<T>, fallback: T): Promise<T> {
    if (this.redis === null) return fallback;
    try {
      return await operation(this.redis);
    } catch {
      return fallback;
    }
  }

  private key(email: string): string {
    return `login-attempts:${email.toLowerCase()}`;
  }
}
