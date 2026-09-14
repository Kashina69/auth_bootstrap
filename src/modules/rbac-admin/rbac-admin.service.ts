import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AUTHZ_PROVIDER_TOKEN,
  PERMISSION_REPOSITORY,
  ROLE_REPOSITORY,
  USER_REPOSITORY,
} from '../../common/constants.js';
import type { Permission, PermissionRepository } from '../../database/repositories/permission.repository.js';
import type { Role, RoleRepository } from '../../database/repositories/role.repository.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import type { IAuthorizationProvider } from '../../rbac-strategies/authorization-provider.interface.js';
import type { AssignRoleDto, AttachPermissionsDto, CreateRoleDto } from './dto/index.js';

/**
 * Runtime RBAC editing — plan.md §5.2, §11 Phase 9.
 *
 * The baseline comes from the seed script; everything after it is a normal DB write through
 * the frozen repository contracts, so a role or grant changes without a redeploy. One method
 * per operation, called by both `rbac-admin.controller.ts` and `rbac-admin.resolver.ts`
 * (plan.md §10) — neither transport owns any rule of its own.
 */
@Injectable()
export class RbacAdminService {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(PERMISSION_REPOSITORY) private readonly permissions: PermissionRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUTHZ_PROVIDER_TOKEN) private readonly authz: IAuthorizationProvider,
  ) {}

  listRoles(): Promise<Role[]> {
    return this.roles.findAll();
  }

  listPermissions(): Promise<Permission[]> {
    return this.permissions.findAll();
  }

  async listRolePermissions(roleId: string): Promise<Permission[]> {
    await this.requireRole(roleId);
    return this.roles.listPermissions(roleId);
  }

  async createRole(dto: CreateRoleDto): Promise<Role> {
    const name = dto.name.trim();
    if (await this.roles.findByName(name)) throw new ConflictException(`Role "${name}" already exists`);
    // `isSystem` is never read from input: the runtime API only creates custom roles (§5.4).
    return this.roles.create({ name, description: dto.description });
  }

  async attachPermissions(roleId: string, dto: AttachPermissionsDto): Promise<Permission[]> {
    await this.requireRole(roleId);
    await this.roles.attachPermissions(roleId, await this.resolvePermissionIds(dto.permissions));
    await this.invalidateRoleHolders(roleId);
    return this.roles.listPermissions(roleId);
  }

  async detachPermissions(roleId: string, dto: AttachPermissionsDto): Promise<Permission[]> {
    await this.requireRole(roleId);
    await this.roles.detachPermissions(roleId, await this.resolvePermissionIds(dto.permissions));
    await this.invalidateRoleHolders(roleId);
    return this.roles.listPermissions(roleId);
  }

  async deleteRole(roleId: string): Promise<void> {
    assertRoleIsRemovable(await this.requireRole(roleId));
    // Read the holders before the delete: afterwards the relation that names them is gone.
    const holders = await this.users.findUserIdsByRole(roleId);
    await this.roles.delete(roleId);
    await this.invalidateAll(holders);
  }

  async deletePermission(permissionId: string): Promise<void> {
    assertPermissionIsRemovable(await this.requirePermission(permissionId));
    await this.permissions.delete(permissionId);
  }

  async assignRoleToUser(userId: string, dto: AssignRoleDto): Promise<void> {
    await this.requireUser(userId);
    const role = await this.requireRole(dto.roleId);
    await this.users.assignRole(userId, role.id);
    // The one mutation whose affected users are named by the caller, so the §5.5 fan-out is
    // exact here rather than role-scoped.
    await this.authz.invalidate(userId);
  }

  /**
   * Resolves every name before writing, and reports all unknown ones at once instead of the
   * first, so an operator fixes a batch in one round trip. Duplicates collapse because
   * `attachPermissions` writes one grant row per permission id.
   */
  private async resolvePermissionIds(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const name of new Set(names)) {
      const permission = await this.permissions.findByName(name);
      if (permission === null) unknown.push(name);
      else ids.push(permission.id);
    }
    if (unknown.length > 0) throw new NotFoundException(`Unknown permission(s): ${unknown.join(', ')}`);
    return ids;
  }

  private async requireRole(roleId: string): Promise<Role> {
    const role = await this.roles.findById(roleId);
    if (role === null) throw new NotFoundException(`No role with id "${roleId}"`);
    return role;
  }

  private async requirePermission(permissionId: string): Promise<Permission> {
    const permission = await this.permissions.findById(permissionId);
    if (permission === null) throw new NotFoundException(`No permission with id "${permissionId}"`);
    return permission;
  }

  private async requireUser(userId: string): Promise<void> {
    if ((await this.users.findById(userId)) === null) throw new NotFoundException(`No user with id "${userId}"`);
  }

  /**
   * plan.md §5.5: under `db-live` the next request would otherwise be answered from a cache
   * entry holding the pre-mutation grants until its TTL expires.
   */
  private async invalidateRoleHolders(roleId: string): Promise<void> {
    await this.invalidateAll(await this.users.findUserIdsByRole(roleId));
  }

  private async invalidateAll(userIds: string[]): Promise<void> {
    for (const userId of userIds) await this.authz.invalidate(userId);
  }
}

/** plan.md §5.4 — the soft guard that keeps `superadmin`/`admin`/`user` from being deleted. */
function assertRoleIsRemovable(role: Role): void {
  if (role.isSystem) throw new ForbiddenException(`Role "${role.name}" is a seeded system role`);
}

/** plan.md §5.4 — the same guard for the baseline permissions the seed marks `isSystem`. */
function assertPermissionIsRemovable(permission: Permission): void {
  if (permission.isSystem) {
    throw new ForbiddenException(`Permission "${permission.name}" is part of the seeded baseline`);
  }
}
