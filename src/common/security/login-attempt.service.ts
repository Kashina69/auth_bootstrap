import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
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
export class LoginAttemptService implements OnModuleInit {
  private readonly logger = new Logger(LoginAttemptService.name);
  private readonly redis: Redis | null;

  constructor(config: AppConfig) {
    this.redis = config.REDIS_URL === undefined ? null : this.createClient(config.REDIS_URL);
  }

  /** The one place a connection is opened — the specs subclass this to hand in a fake. */
  protected createClient(url: string): Redis {
    return new Redis(url);
  }

  onModuleInit(): void {
    if (this.redis === null) {
      this.logger.warn(
        'Per-account login lockout is INACTIVE: REDIS_URL is not set, so login is rate-limited per IP only.',
      );
    }
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
