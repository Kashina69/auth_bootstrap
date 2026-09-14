import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { AUTHZ_PROVIDER_TOKEN, REDIS_CLIENT, USER_REPOSITORY } from '../common/constants.js';
import { AppConfig } from '../config/app-config.service.js';
import type { UserRepository } from '../database/repositories/user.repository.js';
import type { IAuthorizationProvider } from './authorization-provider.interface.js';
import { DbLiveAuthorizationProvider } from './db-live/db-live.authorization-provider.js';
import { EmbeddedClaimsAuthorizationProvider } from './embedded-claims/embedded-claims.authorization-provider.js';

/**
 * The RBAC half of the "0-effort switch" in plan.md §3.2: `RBAC_STRATEGY` is read once
 * at boot and the matching concrete class is bound to `AUTHZ_PROVIDER_TOKEN`. Guards
 * inject only the token, so they are identical under either strategy.
 *
 * Deleting either strategy folder only requires removing its `case` from
 * `createAuthorizationProvider` — nothing else in the app references a concrete class.
 */
@Global()
@Module({})
export class RbacStrategiesModule {
  static register(): DynamicModule {
    return {
      module: RbacStrategiesModule,
      providers: [
        createRedisClientProvider(),
        createAuthorizationProviderProvider(),
        RedisClientLifecycle,
      ],
      exports: [AUTHZ_PROVIDER_TOKEN],
    };
  }
}

function createAuthorizationProviderProvider(): Provider {
  return {
    provide: AUTHZ_PROVIDER_TOKEN,
    useFactory: createAuthorizationProvider,
    inject: [AppConfig, USER_REPOSITORY, REDIS_CLIENT],
  };
}

function createAuthorizationProvider(
  config: AppConfig,
  users: UserRepository,
  redis: Redis,
): IAuthorizationProvider {
  switch (config.RBAC_STRATEGY) {
    case 'db-live':
      return new DbLiveAuthorizationProvider(users, redis, config);
    case 'embedded-claims':
    default:
      return new EmbeddedClaimsAuthorizationProvider(config);
  }
}

/**
 * Only `db-live` needs Redis (its short-TTL context cache); `embedded-claims` reads the
 * claims straight off the verified token, so the default env keeps this a stub.
 */
function createRedisClientProvider(): Provider {
  return {
    provide: REDIS_CLIENT,
    useFactory: createRedisClient,
    inject: [AppConfig],
  };
}

/**
 * Closes `REDIS_CLIENT` when the app shuts down.
 *
 * The client is built by a factory, so the teardown needs a provider of its own — and without
 * one the `db-live` cache keeps a socket and a reconnect timer open, so the process never
 * exits after `app.close()` and `main.ts`'s `enableShutdownHooks()` tears down with the
 * connection still up. `quit()` is issued through the stub harmlessly because the stub answers
 * it with a no-op (see `createThrowingStub`).
 */
@Injectable()
export class RedisClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

const redisClientLogger = new Logger('RedisClient');

function createRedisClient(config: AppConfig): Redis {
  if (config.RBAC_STRATEGY === 'db-live' && config.REDIS_URL) {
    const client = new Redis(config.REDIS_URL);
    // `ioredis` is an EventEmitter, and an `error` event with no listener is logged by
    // ioredis as an "Unhandled error event". Command failures are handled where the cache
    // calls are made; this covers the connection-level channel, which is otherwise bare.
    client.on('error', (error: Error) => {
      redisClientLogger.warn(`Redis error for the db-live cache: ${error.message}`);
    });
    return client;
  }
  return createThrowingStub('REDIS_CLIENT is unavailable: REDIS_URL is not set for this RBAC_STRATEGY');
}

/**
 * A stand-in for the Redis client under the default (Redis-free) env: any method call
 * throws. The keys Nest itself probes — the thenable check, symbols, and the lifecycle
 * hooks it looks for on every provider — resolve to `undefined` instead, so DI and app
 * shutdown still succeed.
 *
 * `quit` is the one deliberate exception: `RedisClientLifecycle` calls it on shutdown, so it
 * resolves to a no-op rather than `refuse`. Shutdown is not the place to discover that this
 * app never had a Redis — there is nothing to close and nothing to report.
 */
function createThrowingStub(reason: string): Redis {
  const refuse = (): never => {
    throw new Error(reason);
  };
  return new Proxy({} as Redis, {
    get(target, property) {
      if (typeof property === 'symbol' || NEST_PROBE_KEYS.has(property)) {
        return Reflect.get(target, property);
      }
      if (property === 'quit') return async (): Promise<'OK'> => 'OK';
      return refuse;
    },
  });
}

const NEST_PROBE_KEYS = new Set([
  'constructor',
  'then',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
]);
