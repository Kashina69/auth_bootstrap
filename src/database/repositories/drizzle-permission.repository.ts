import { asc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '../drizzle/client.js';
import { permissions } from '../drizzle/schema.js';
import type { Permission, PermissionRepository } from './permission.repository.js';

export class DrizzlePermissionRepository implements PermissionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findById(id: string): Promise<Permission | null> {
    const [row] = await this.db.select().from(permissions).where(eq(permissions.id, id)).limit(1);
    return row ?? null;
  }

  async findByName(name: string): Promise<Permission | null> {
    const [row] = await this.db.select().from(permissions).where(eq(permissions.name, name)).limit(1);
    return row ?? null;
  }

  async findAll(): Promise<Permission[]> {
    return this.db.select().from(permissions).orderBy(asc(permissions.name));
  }

  async create(data: {
    action: string;
    subject: string;
    description?: string;
    isSystem?: boolean;
  }): Promise<Permission> {
    const [row] = await this.db
      .insert(permissions)
      .values({
        action: data.action,
        subject: data.subject,
        name: `${data.action}:${data.subject}`,
        description: data.description ?? null,
        isSystem: data.isSystem ?? false,
      })
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(permissions).where(eq(permissions.id, id));
  }
}
