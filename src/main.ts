import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { DEFAULT_PORT } from './config/constants.js';
import { configureApp } from './configure-app.js';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await configureApp(app);
  // Kept out of `configureApp`: shutdown hooks attach process-level listeners, and the test
  // harness closes an app per strategy. Nothing about serving a request depends on them.
  app.enableShutdownHooks();
  await app.listen(resolvePort(), '0.0.0.0');
  logger.log(`HTTP server listening on port ${resolvePort()}`);
}

function resolvePort(): number {
  return Number(process.env.PORT ?? DEFAULT_PORT);
}

await bootstrap();
