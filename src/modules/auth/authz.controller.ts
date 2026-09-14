import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RbacGuard } from '../../common/guards/rbac.guard.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { AuthzService, type PermissionCheckResult } from './authz.service.js';
import { CheckPermissionDto } from './dto/index.js';

/**
 * The REST half of the authorization-query surface (plan.md §11 Phase 12).
 *
 * `AuthGuard` runs first so `RbacGuard` and `@CurrentUser()` see the identity, exactly as on
 * the guarded auth routes. There is deliberately no `@Permissions()` here: this endpoint asks
 * about the *caller's own* grants and performs no privileged action, so requiring a permission
 * to ask whether one holds a permission would be circular. The answer it returns comes from the
 * same `can()` the guard uses, so a UI that hides a button on `allowed: false` matches what the
 * server will actually enforce.
 */
@Controller('authz')
@UseGuards(AuthGuard, RbacGuard)
export class AuthzController {
  constructor(private readonly authz: AuthzService) {}

  @Post('check')
  @HttpCode(HttpStatus.OK)
  check(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckPermissionDto,
  ): Promise<PermissionCheckResult> {
    return this.authz.checkPermission(user, dto.action, dto.subject);
  }
}
