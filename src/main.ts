import fastifyCors from '@fastify/cors';
import fastifyCsrfProtection from '@fastify/csrf-protection';
import fastifyHelmet from '@fastify/helmet';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { AppConfig } from './config/app-config.service.js';
import { DEFAULT_PORT } from './config/constants.js';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  const config = app.get(AppConfig);
  await registerSecurityHeaders(app);
  await registerCsrfProtectionForCookieSessions(app, config);
  await registerCors(app, config);
  registerGlobalValidation(app);
  registerGlobalInterceptors(app);
  registerGlobalFilters(app);
  app.enableShutdownHooks();
  await app.listen(resolvePort(), '0.0.0.0');
  logger.log(`HTTP server listening on port ${resolvePort()}`);
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
 */
async function registerCors(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const allowedOrigins = config.CORS_ORIGINS;
  if (allowedOrigins.length === 0) return;
  await app.register(fastifyCors, {
    origin: allowedOrigins,
    credentials: config.AUTH_STRATEGY === 'session-redis',
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

function resolvePort(): number {
  return Number(process.env.PORT ?? DEFAULT_PORT);
}

await bootstrap();
