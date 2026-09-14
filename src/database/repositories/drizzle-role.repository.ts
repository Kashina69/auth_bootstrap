import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../drizzle/client.js';
import { permissions, rolePermissions, roles } from '../drizzle/schema.js';
import type { Permission } from './permission.repository.js';
import type { Role, RoleRepository } from './role.repository.js';

export class DrizzleRoleRepository implements RoleRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findById(id: string): Promise<Role | null> {
    const [row] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    return row ?? null;
  }

  async findByName(name: string): Promise<Role | null> {
    const [row] = await this.db.select().from(roles).where(eq(roles.name, name)).limit(1);
    return row ?? null;
  }

  async findAll(): Promise<Role[]> {
    return this.db.select().from(roles).orderBy(asc(roles.name));
  }

  async create(data: { name: string; description?: string; isSystem?: boolean }): Promise<Role> {
    const [row] = await this.db
      .insert(roles)
      .values({
        name: data.name,
        description: data.description ?? null,
        isSystem: data.isSystem ?? false,
      })
      .returning();
    return row;
  }

  async attachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    if (permissionIds.length === 0) return;
    await this.db
      .insert(rolePermissions)
      .values(permissionIds.map((permissionId) => ({ roleId, permissionId })))
      .onConflictDoNothing();
  }

  async detachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    if (permissionIds.length === 0) return;
    await this.db
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.roleId, roleId), inArray(rolePermissions.permissionId, permissionIds)));
  }

  async listPermissions(roleId: string): Promise<Permission[]> {
    return this.db
      .select({
        id: permissions.id,
        action: permissions.action,
        subject: permissions.subject,
        name: permissions.name,
        description: permissions.description,
        isSystem: permissions.isSystem,
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, roleId));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(roles).where(eq(roles.id, id));
  }
}
