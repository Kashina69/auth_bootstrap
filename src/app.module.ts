import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthStrategiesModule } from './auth-strategies/auth-strategies.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { AppConfigModule } from './config/app-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { RbacStrategiesModule } from './rbac-strategies/rbac-strategies.module.js';

/**
 * Composition root. Config, data and strategy modules are all `@Global()` and registered
 * once here, alongside the auth feature module, which relies on those globals rather than
 * re-importing them; the cross-cutting providers are attached globally in `main.ts`.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule.register(),
    AuthStrategiesModule.register(),
    RbacStrategiesModule.register(),
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService, HttpExceptionFilter, LoggingInterceptor, TimeoutInterceptor, TransformInterceptor],
})
export class AppModule {}
