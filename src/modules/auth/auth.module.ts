import { Module } from '@nestjs/common';
import { LoginAttemptService } from '../../common/security/login-attempt.service.js';
import { PasswordService } from '../../common/security/password.service.js';
import { AuthController } from './auth.controller.js';
import { AuthResolver } from './auth.resolver.js';
import { AuthService } from './auth.service.js';
import { AuthzController } from './authz.controller.js';
import { AuthzResolver } from './authz.resolver.js';
import { AuthzService } from './authz.service.js';

/**
 * The REST auth surface. `AuthStrategiesModule` / `RbacStrategiesModule` / `DatabaseModule`
 * are `@Global()` in the composition root, so the strategy, repository and config tokens the
 * guards, `AuthService` and `AuthzService` inject resolve without being re-imported here — and
 * nothing in this module names a concrete strategy.
 */
@Module({
  controllers: [AuthController, AuthzController],
  providers: [AuthService, AuthzService, PasswordService, LoginAttemptService, AuthResolver, AuthzResolver],
})
export class AuthModule {}
