import type { PrismaClient, Permission as PermissionRow, Role as RoleRow } from '@prisma/client';
import type { Permission } from './permission.repository.js';
import type { Role, RoleRepository } from './role.repository.js';

/**
 * Prisma implementation of `RoleRepository`. Bound to the `ROLE_REPOSITORY` token by
 * `DatabaseModule.register()` when `DB_PROVIDER=prisma`.
 */
export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<Role | null> {
    const row = await this.prisma.role.findUnique({ where: { id } });
    return row === null ? null : toRole(row);
  }

  async findByName(name: string): Promise<Role | null> {
    const row = await this.prisma.role.findUnique({ where: { name } });
    return row === null ? null : toRole(row);
  }

  async findAll(): Promise<Role[]> {
    const rows = await this.prisma.role.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toRole);
  }

  async create(data: { name: string; description?: string; isSystem?: boolean }): Promise<Role> {
    const row = await this.prisma.role.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        isSystem: data.isSystem ?? false,
      },
    });
    return toRole(row);
  }

  /**
   * Additive and idempotent, so re-running the seed (plan.md §5) never fails on grants
   * that already exist: one multi-row insert, `skipDuplicates` swallowing re-attachments.
   */
  async attachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    await this.prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true,
    });
  }

  /** The mirror of `attachPermissions`, and idempotent for the same reason: `deleteMany` of
   *  a grant that is not there is a no-op, not an error. */
  async detachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    await this.prisma.rolePermission.deleteMany({
      where: { roleId, permissionId: { in: permissionIds } },
    });
  }

  async listPermissions(roleId: string): Promise<Permission[]> {
    const grants = await this.prisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true },
      orderBy: { permission: { name: 'asc' } },
    });
    return grants.map((grant) => toPermission(grant.permission));
  }

  async delete(id: string): Promise<void> {
    await this.prisma.role.deleteMany({ where: { id } });
  }
}

function toRole(row: RoleRow): Role {
  return { id: row.id, name: row.name, description: row.description, isSystem: row.isSystem };
}

function toPermission(row: PermissionRow): Permission {
  return {
    id: row.id,
    action: row.action,
    subject: row.subject,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
  };
}
