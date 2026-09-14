import { Module } from '@nestjs/common';
import { PasswordService } from '../../common/security/password.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

/**
 * The REST auth surface. `AuthStrategiesModule` / `RbacStrategiesModule` / `DatabaseModule`
 * are `@Global()` in the composition root, so the strategy, repository and config tokens the
 * guards and `AuthService` inject resolve without being re-imported here — and nothing in
 * this module names a concrete strategy.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
})
export class AuthModule {}
