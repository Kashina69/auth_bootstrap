import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '../drizzle/client.js';
import { permissions, rolePermissions, roles, userRoles, users } from '../drizzle/schema.js';
import type { User, UserRepository } from './user.repository.js';

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async create(data: { email: string; passwordHash: string }): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({ email: data.email, passwordHash: data.passwordHash })
      .returning();
    return row;
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, id));
  }

  async assignRole(userId: string, roleId: string): Promise<void> {
    await this.db.insert(userRoles).values({ userId, roleId }).onConflictDoNothing();
  }

  async findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }> {
    const rows = await this.db
      .select({
        roleName: roles.name,
        action: permissions.action,
        subject: permissions.subject,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(userRoles.userId, id));

    return {
      roles: dedupe(rows.map((row) => row.roleName)),
      permissions: dedupe(rows.flatMap(toPermissionName)),
    };
  }
}

type GrantRow = {
  roleName: string;
  action: string | null;
  subject: string | null;
};

function toPermissionName(row: GrantRow): string[] {
  return row.action === null || row.subject === null ? [] : [`${row.action}:${row.subject}`];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
