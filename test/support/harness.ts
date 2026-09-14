import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import {
  PERMISSION_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  ROLE_REPOSITORY,
  USER_REPOSITORY,
} from '../../src/common/constants.js';
import { LoginAttemptService } from '../../src/common/security/login-attempt.service.js';
import { AppConfig } from '../../src/config/app-config.service.js';
import { configureApp } from '../../src/configure-app.js';
import {
  createInMemoryPermissionRepository,
  createInMemoryRefreshTokenRepository,
  createInMemoryRoleRepository,
  createInMemoryUserRepository,
  type InMemoryStore,
} from './in-memory-repositories.js';
import {
  createTestThrottlerStorage,
  type ResettableThrottlerStorage,
} from './test-throttler-storage.js';

/**
 * The one e2e harness. TEST-PLAN.md §5 Wave 0 froze it so the REST and GraphQL suites could
 * be built in parallel without either owning this file: both `import` it, neither edits it.
 *
 * Only the persistence boundary and the two Redis clients are substituted. `AppModule` itself,
 * every guard, strategy, resolver, controller, DTO and interceptor is the real one — which is
 * what makes an assertion here evidence about the app rather than about a fake.
 */

/** plan.md §11 Phase 13: the same suite, run once per `AUTH_STRATEGY` value. */
export const STRATEGIES = ['jwt-stateless', 'session-redis'] as const;
export type AuthStrategy = (typeof STRATEGIES)[number];

export const PASSWORD = 'Passw0rd!23';

/** What `register`/`login` hand back — the credential differs per strategy, nothing else does. */
export interface Session {
  accessToken?: string;
  refreshToken?: string;
}

/**
 * The store is shared by every test in a run (rebuilding the app per test would mean two app
 * boots per assertion), so each test that needs an account registers its own address rather
 * than depending on one a sibling test may already have created.
 */
let emailCounter = 0;
export function uniqueEmail(): string {
  emailCounter += 1;
  return `user${emailCounter}@example.com`;
}

/**
 * Applies the strategy's own credential to a request. This is the only place the two runs
 * diverge: `jwt-stateless` carries a bearer access token, `session-redis` an opaque session
 * id in its cookie. Every assertion written against it holds for both.
 */
export function authorize(req: request.Test, session: Session, strategy: AuthStrategy): request.Test {
  return strategy === 'session-redis'
    ? req.set('Cookie', `sid=${encodeURIComponent(session.refreshToken ?? '')}`)
    : req.set('Authorization', `Bearer ${session.accessToken}`);
}

/**
 * Boots the real `AppModule` with only the persistence boundary replaced, then applies the
 * app's own global setup via `configureApp` — the same function `main.ts` calls, so the suite
 * cannot drift from the surface a real client talks to.
 */
export async function createTestApp(
  strategy: AuthStrategy,
  store: InMemoryStore,
): Promise<{ app: NestFastifyApplication; throttler: ResettableThrottlerStorage }> {
  const configRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const realConfig = configRef.get(AppConfig);
  const strategyConfig = new Proxy(realConfig, {
    get(target, property) {
      if (property === 'AUTH_STRATEGY') return strategy;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await configRef.close();

  const throttler = createTestThrottlerStorage();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue(strategyConfig)
    .overrideProvider(USER_REPOSITORY)
    .useValue(createInMemoryUserRepository(store))
    .overrideProvider(ROLE_REPOSITORY)
    .useValue(createInMemoryRoleRepository(store))
    .overrideProvider(PERMISSION_REPOSITORY)
    .useValue(createInMemoryPermissionRepository(store))
    .overrideProvider(REFRESH_TOKEN_REPOSITORY)
    .useValue(createInMemoryRefreshTokenRepository(store))
    .overrideProvider(ThrottlerStorage)
    .useValue(throttler)
    // `LoginAttemptService` builds its own client (neither strategy module exports
    // `REDIS_CLIENT`), so it is handed one through the seam its doc comment names for specs.
    .overrideProvider(LoginAttemptService)
    .useValue(new InMemoryLoginAttemptService(strategyConfig))
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, throttler };
}

/**
 * `LoginAttemptService`'s own in-memory Redis, so the suite never dials 127.0.0.1:6379 while
 * the lockout counter still behaves like the real thing (a failing login still counts).
 */
class InMemoryLoginAttemptService extends LoginAttemptService {
  protected override createClient(): Redis {
    const entries = new Map<string, string>();
    return {
      async incr(key: string) {
        const next = Number(entries.get(key) ?? 0) + 1;
        entries.set(key, String(next));
        return next;
      },
      async expire() {
        return 1;
      },
      async get(key: string) {
        return entries.get(key) ?? null;
      },
      async del(key: string) {
        return entries.delete(key) ? 1 : 0;
      },
      // `LoginAttemptService.onModuleDestroy` quits its client when the app closes.
      async quit() {
        entries.clear();
        return 'OK';
      },
    } as unknown as Redis;
  }
}
