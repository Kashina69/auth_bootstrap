import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfig } from './app-config.service.js';
import { validateEnv } from './env.schema.js';

/**
 * Global so every later wave injects `AppConfig` without re-importing anything — this is
 * the `AppConfig` provider that plan.md §3.2 factories inject alongside the strategy
 * tokens.
 */
@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })],
  providers: [AppConfig],
  exports: [AppConfig],
})
export class AppConfigModule {}
