import { Types, type Connection } from 'mongoose';
import { mongooseModels, type MongooseModels } from '../mongoose/connection.js';
import type { PermissionDocument } from '../mongoose/schemas/permission.schema.js';
import type { Permission, PermissionRepository } from './permission.repository.js';

export class MongoosePermissionRepository implements PermissionRepository {
  private readonly models: MongooseModels;

  constructor(connection: Connection) {
    this.models = mongooseModels(connection);
  }

  async findById(id: string): Promise<Permission | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await this.models.Permission.findById(id).lean();
    return doc === null ? null : toPermission(doc);
  }

  async findByName(name: string): Promise<Permission | null> {
    const doc = await this.models.Permission.findOne({ name }).lean();
    return doc === null ? null : toPermission(doc);
  }

  async findAll(): Promise<Permission[]> {
    const docs = await this.models.Permission.find().sort({ name: 1 }).lean();
    return docs.map(toPermission);
  }

  async create(data: {
    action: string;
    subject: string;
    description?: string;
    isSystem?: boolean;
  }): Promise<Permission> {
    const doc = await this.models.Permission.create({
      action: data.action,
      subject: data.subject,
      name: `${data.action}:${data.subject}`,
      description: data.description ?? null,
      isSystem: data.isSystem ?? false,
    });
    return toPermission(doc.toObject());
  }

  /** Mirrors the FK cascade: the permission leaves `role_permissions` too. */
  async delete(id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    const permissionId = new Types.ObjectId(id);
    await this.models.Permission.deleteOne({ _id: permissionId });
    await this.models.Role.updateMany({ permissionIds: permissionId }, { $pull: { permissionIds: permissionId } });
  }
}

function toPermission(row: PermissionDocument): Permission {
  return {
    id: row._id.toString(),
    action: row.action,
    subject: row.subject,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
  };
}
