import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
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
      providers: [createRedisClientProvider(), createAuthorizationProviderProvider()],
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

function createRedisClient(config: AppConfig): Redis {
  if (config.RBAC_STRATEGY === 'db-live' && config.REDIS_URL) {
    return new Redis(config.REDIS_URL);
  }
  return createThrowingStub('REDIS_CLIENT is unavailable: REDIS_URL is not set for this RBAC_STRATEGY');
}

/**
 * A stand-in for the Redis client under the default (Redis-free) env: any method call
 * throws. The keys Nest itself probes — the thenable check, symbols, and the lifecycle
 * hooks it looks for on every provider — resolve to `undefined` instead, so DI and app
 * shutdown still succeed.
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
