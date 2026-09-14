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
import { GraphqlModule } from './graphql/graphql.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { RbacAdminModule } from './modules/rbac-admin/rbac-admin.module.js';
import { RbacStrategiesModule } from './rbac-strategies/rbac-strategies.module.js';

/**
 * Composition root. Config, data and strategy modules are all `@Global()` and registered
 * once here, alongside the GraphQL bootstrap and the auth / rbac-admin feature modules,
 * which rely on those globals rather than re-importing them; the cross-cutting providers
 * are attached globally in `main.ts`.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule.register(),
    AuthStrategiesModule.register(),
    RbacStrategiesModule.register(),
    GraphqlModule,
    AuthModule,
    RbacAdminModule,
  ],
  controllers: [AppController],
  providers: [AppService, HttpExceptionFilter, LoggingInterceptor, TimeoutInterceptor, TransformInterceptor],
})
export class AppModule {}
