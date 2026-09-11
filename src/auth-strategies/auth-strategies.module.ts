import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { JwtModule, JwtService, type JwtModuleOptions } from '@nestjs/jwt';
import { Redis } from 'ioredis';
import { AUTH_STRATEGY_TOKEN, REDIS_CLIENT, REFRESH_TOKEN_REPOSITORY, USER_REPOSITORY } from '../common/constants.js';
import { AppConfig } from '../config/app-config.service.js';
import type { RefreshTokenRepository } from '../database/repositories/refresh-token.repository.js';
import type { UserRepository } from '../database/repositories/user.repository.js';
import type { IAuthStrategy } from './auth-strategy.interface.js';
import { JwtStatelessAuthStrategy } from './jwt-stateless/jwt-stateless.auth-strategy.js';
import { SessionRedisAuthStrategy } from './session-redis/session-redis.auth-strategy.js';

/**
 * The auth half of the "0-effort switch" in plan.md §3.2: `AUTH_STRATEGY` is read once
 * at boot and the matching concrete class is bound to `AUTH_STRATEGY_TOKEN`. Everything
 * downstream injects the token and never imports a concrete strategy.
 *
 * Deleting either strategy folder only requires removing its `case` from
 * `createAuthStrategy` — nothing else in the app references a concrete class.
 */
@Global()
@Module({})
export class AuthStrategiesModule {
  static register(): DynamicModule {
    return {
      module: AuthStrategiesModule,
      imports: [
        JwtModule.registerAsync({ inject: [AppConfig], useFactory: createJwtModuleOptions }),
      ],
      providers: [createRedisClientProvider(), createAuthStrategyProvider()],
      exports: [AUTH_STRATEGY_TOKEN],
    };
  }
}

function createJwtModuleOptions(config: AppConfig): JwtModuleOptions {
  return config.JWT_ALGORITHM === 'RS256'
    ? { privateKey: config.JWT_PRIVATE_KEY, publicKey: config.JWT_PUBLIC_KEY }
    : { secret: config.JWT_SECRET };
}

function createAuthStrategyProvider(): Provider {
  return {
    provide: AUTH_STRATEGY_TOKEN,
    useFactory: createAuthStrategy,
    inject: [AppConfig, JwtService, REFRESH_TOKEN_REPOSITORY, USER_REPOSITORY, REDIS_CLIENT],
  };
}

function createAuthStrategy(
  config: AppConfig,
  jwt: JwtService,
  refreshTokens: RefreshTokenRepository,
  users: UserRepository,
  redis: Redis,
): IAuthStrategy {
  switch (config.AUTH_STRATEGY) {
    case 'session-redis':
      return new SessionRedisAuthStrategy(redis, config);
    case 'jwt-stateless':
    default:
      return new JwtStatelessAuthStrategy(refreshTokens, users, jwt, config);
  }
}

/**
 * `jwt-stateless` never touches Redis, so a real client is only dialed when the
 * session store is actually in use — the default env keeps this a stub.
 */
function createRedisClientProvider(): Provider {
  return {
    provide: REDIS_CLIENT,
    useFactory: createRedisClient,
    inject: [AppConfig],
  };
}

function createRedisClient(config: AppConfig): Redis {
  if (config.AUTH_STRATEGY === 'session-redis' && config.REDIS_URL) {
    return new Redis(config.REDIS_URL);
  }
  return createThrowingStub('REDIS_CLIENT is unavailable: REDIS_URL is not set for this AUTH_STRATEGY');
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
