import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Permissions } from '../../common/decorators/permissions.decorator.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RbacGuard } from '../../common/guards/rbac.guard.js';
import type { Permission } from '../../database/repositories/permission.repository.js';
import type { Role } from '../../database/repositories/role.repository.js';
import { AssignRoleDto, AttachPermissionsDto, CreateRoleDto } from './dto/index.js';
import { RbacPermission, RbacRole } from './rbac-admin.models.js';
import { RbacAdminService } from './rbac-admin.service.js';

/**
 * The GraphQL half of the same surface (plan.md §10): every field resolves through the same
 * `RbacAdminService` method its REST twin calls, so no rule is expressed twice and the two
 * transports cannot drift. `AuthGuard`/`RbacGuard` read the GraphQL execution context
 * themselves, which is why this file needs no transport-specific guarding code.
 *
 * Fields that would return nothing are typed `Boolean` — GraphQL has no `void`.
 */
@Resolver(() => RbacRole)
@UseGuards(AuthGuard, RbacGuard)
@Permissions('manage:User')
export class RbacAdminResolver {
  constructor(private readonly rbacAdmin: RbacAdminService) {}

  @Query(() => [RbacRole])
  roles(): Promise<Role[]> {
    return this.rbacAdmin.listRoles();
  }

  @Query(() => [RbacPermission])
  permissions(): Promise<Permission[]> {
    return this.rbacAdmin.listPermissions();
  }

  @Query(() => [RbacPermission])
  rolePermissions(@Args('roleId', { type: () => ID }) roleId: string): Promise<Permission[]> {
    return this.rbacAdmin.listRolePermissions(roleId);
  }

  @Mutation(() => RbacRole)
  createRole(@Args('input') input: CreateRoleDto): Promise<Role> {
    return this.rbacAdmin.createRole(input);
  }

  @Mutation(() => [RbacPermission])
  attachPermissions(
    @Args('roleId', { type: () => ID }) roleId: string,
    @Args('input') input: AttachPermissionsDto,
  ): Promise<Permission[]> {
    return this.rbacAdmin.attachPermissions(roleId, input);
  }

  @Mutation(() => Boolean)
  async deleteRole(@Args('roleId', { type: () => ID }) roleId: string): Promise<boolean> {
    await this.rbacAdmin.deleteRole(roleId);
    return true;
  }

  @Mutation(() => Boolean)
  async deletePermission(@Args('permissionId', { type: () => ID }) permissionId: string): Promise<boolean> {
    await this.rbacAdmin.deletePermission(permissionId);
    return true;
  }

  @Mutation(() => Boolean)
  async assignRole(
    @Args('userId', { type: () => ID }) userId: string,
    @Args('input') input: AssignRoleDto,
  ): Promise<boolean> {
    await this.rbacAdmin.assignRoleToUser(userId, input);
    return true;
  }
}
