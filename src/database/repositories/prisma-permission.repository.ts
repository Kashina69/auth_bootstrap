import type { PrismaClient, Permission as PermissionRow } from '@prisma/client';
import type { Permission, PermissionRepository } from './permission.repository.js';

/**
 * Prisma implementation of `PermissionRepository`. Bound to the `PERMISSION_REPOSITORY`
 * token by `DatabaseModule.register()` when `DB_PROVIDER=prisma`.
 */
export class PrismaPermissionRepository implements PermissionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<Permission | null> {
    const row = await this.prisma.permission.findUnique({ where: { id } });
    return row === null ? null : toPermission(row);
  }

  async findByName(name: string): Promise<Permission | null> {
    const row = await this.prisma.permission.findUnique({ where: { name } });
    return row === null ? null : toPermission(row);
  }

  async findAll(): Promise<Permission[]> {
    const rows = await this.prisma.permission.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toPermission);
  }

  /**
   * `name` is derived here rather than by the caller so the `"{action}:{subject}"`
   * invariant (plan.md §4) holds for every writer, including the seed and the RBAC admin
   * API. It is stored, not a Postgres generated column, because Prisma cannot express one.
   */
  async create(data: {
    action: string;
    subject: string;
    description?: string;
    isSystem?: boolean;
  }): Promise<Permission> {
    const row = await this.prisma.permission.create({
      data: {
        action: data.action,
        subject: data.subject,
        name: permissionName(data.action, data.subject),
        description: data.description ?? null,
        isSystem: data.isSystem ?? false,
      },
    });
    return toPermission(row);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.permission.deleteMany({ where: { id } });
  }
}

function permissionName(action: string, subject: string): string {
  return `${action}:${subject}`;
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
