import fastifyCors from '@fastify/cors';
import fastifyCsrfProtection from '@fastify/csrf-protection';
import fastifyHelmet from '@fastify/helmet';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { AppConfig } from './config/app-config.service.js';

/**
 * Everything that must be true of the app before it serves a request, in one place.
 *
 * `main.ts` and the test harness both call this. They used to keep private copies, which
 * meant a global enhancer added here was silently absent from every test until someone
 * remembered to add it there too — and the CSRF registration below was the piece nobody
 * remembered, so that path had no test at all (TEST-PLAN.md §3.5).
 *
 * The config is resolved from the app's own container rather than passed in, so a test
 * that overrides `AppConfig` gets the behaviour it overrode for.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const config = app.get(AppConfig);
  await registerSecurityHeaders(app);
  await registerCsrfProtectionForCookieSessions(app, config);
  await registerCors(app, config);
  registerGlobalValidation(app);
  registerGlobalInterceptors(app);
  registerGlobalFilters(app);
}

async function registerSecurityHeaders(app: NestFastifyApplication): Promise<void> {
  await app.register(fastifyHelmet);
}

/** implementation.spec.md §7: CSRF is needed only when an ambient cookie credential exists. */
async function registerCsrfProtectionForCookieSessions(
  app: NestFastifyApplication,
  config: AppConfig,
): Promise<void> {
  if (config.AUTH_STRATEGY !== 'session-redis') return;
  await app.register(fastifyCsrfProtection, { cookieOpts: { signed: true } });
}

/**
 * plan.md §8: an explicit allow-list, never `*`. An unset list leaves CORS off rather than
 * falling back to a permissive default. Credentials follow the cookie session, since a
 * browser only attaches the session cookie cross-origin when the server opts in.
 *
 * `methods` is explicit because the plugin default answers preflights with only
 * GET/HEAD/POST, which silently blocks the API's own DELETE routes (detach
 * permissions, delete role/permission) for every browser client.
 */
async function registerCors(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const allowedOrigins = config.CORS_ORIGINS;
  if (allowedOrigins.length === 0) return;
  await app.register(fastifyCors, {
    origin: allowedOrigins,
    credentials: config.AUTH_STRATEGY === 'session-redis',
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  });
}

function registerGlobalValidation(app: NestFastifyApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}

function registerGlobalInterceptors(app: NestFastifyApplication): void {
  app.useGlobalInterceptors(
    app.get(LoggingInterceptor),
    app.get(TimeoutInterceptor),
    app.get(TransformInterceptor),
  );
}

function registerGlobalFilters(app: NestFastifyApplication): void {
  app.useGlobalFilters(app.get(HttpExceptionFilter));
}
