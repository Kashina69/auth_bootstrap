import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Permissions } from '../../common/decorators/permissions.decorator.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RbacGuard } from '../../common/guards/rbac.guard.js';
import type { Permission } from '../../database/repositories/permission.repository.js';
import type { Role } from '../../database/repositories/role.repository.js';
import { AssignRoleDto, AttachPermissionsDto, CreateRoleDto } from './dto/index.js';
import { RbacAdminService } from './rbac-admin.service.js';

/**
 * The REST half of the RBAC admin surface (plan.md §9, §11 Phase 9). Guard order follows the
 * security invariant — `AuthGuard` resolves the identity, then `RbacGuard` decides — and the
 * class-level `@Permissions('manage:User')` covers every route below it, so a new endpoint is
 * protected by default rather than by remembering to decorate it (`manage:all` also passes).
 *
 * Each method is the same three steps — read the input, hand it to the service, return what
 * the service returned — because the transport contributes nothing but the shape of the call.
 */
@Controller('rbac-admin')
@UseGuards(AuthGuard, RbacGuard)
@Permissions('manage:User')
export class RbacAdminController {
  constructor(private readonly rbacAdmin: RbacAdminService) {}

  @Get('roles')
  listRoles(): Promise<Role[]> {
    return this.rbacAdmin.listRoles();
  }

  @Post('roles')
  createRole(@Body() dto: CreateRoleDto): Promise<Role> {
    return this.rbacAdmin.createRole(dto);
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRole(@Param('id') id: string): Promise<void> {
    return this.rbacAdmin.deleteRole(id);
  }

  @Get('roles/:id/permissions')
  listRolePermissions(@Param('id') id: string): Promise<Permission[]> {
    return this.rbacAdmin.listRolePermissions(id);
  }

  @Post('roles/:id/permissions')
  attachPermissions(@Param('id') id: string, @Body() dto: AttachPermissionsDto): Promise<Permission[]> {
    return this.rbacAdmin.attachPermissions(id, dto);
  }

  @Get('permissions')
  listPermissions(): Promise<Permission[]> {
    return this.rbacAdmin.listPermissions();
  }

  @Delete('permissions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePermission(@Param('id') id: string): Promise<void> {
    return this.rbacAdmin.deletePermission(id);
  }

  @Post('users/:userId/roles')
  @HttpCode(HttpStatus.NO_CONTENT)
  assignRole(@Param('userId') userId: string, @Body() dto: AssignRoleDto): Promise<void> {
    return this.rbacAdmin.assignRoleToUser(userId, dto);
  }
}
