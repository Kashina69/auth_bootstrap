import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RbacGuard } from '../../common/guards/rbac.guard.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { PermissionCheckResultType } from './authz.models.js';
import { AuthzService, type PermissionCheckResult } from './authz.service.js';
import { CheckPermissionDto } from './dto/index.js';

/**
 * The GraphQL half of the authorization-query surface, matching `authz.controller.ts` field for
 * field and guard for guard: same service method, same absence of a `@Permissions()` gate, so
 * neither transport can answer differently about the same identity.
 */
@Resolver()
@UseGuards(AuthGuard, RbacGuard)
export class AuthzResolver {
  constructor(private readonly authz: AuthzService) {}

  @Query(() => PermissionCheckResultType)
  checkPermission(
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') dto: CheckPermissionDto,
  ): Promise<PermissionCheckResult> {
    return this.authz.checkPermission(user, dto.action, dto.subject);
  }
}
