import { Types, type Connection } from 'mongoose';
import { mongooseModels, type MongooseModels } from '../mongoose/connection.js';
import type { PermissionDocument } from '../mongoose/schemas/permission.schema.js';
import type { RoleDocument } from '../mongoose/schemas/role.schema.js';
import type { Permission } from './permission.repository.js';
import type { Role, RoleRepository } from './role.repository.js';

export class MongooseRoleRepository implements RoleRepository {
  private readonly models: MongooseModels;

  constructor(connection: Connection) {
    this.models = mongooseModels(connection);
  }

  async findById(id: string): Promise<Role | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await this.models.Role.findById(id).lean();
    return doc === null ? null : toRole(doc);
  }

  async findByName(name: string): Promise<Role | null> {
    const doc = await this.models.Role.findOne({ name }).lean();
    return doc === null ? null : toRole(doc);
  }

  async findAll(): Promise<Role[]> {
    const docs = await this.models.Role.find().sort({ name: 1 }).lean();
    return docs.map(toRole);
  }

  async create(data: { name: string; description?: string; isSystem?: boolean }): Promise<Role> {
    const doc = await this.models.Role.create({
      name: data.name,
      description: data.description ?? null,
      isSystem: data.isSystem ?? false,
    });
    return toRole(doc.toObject());
  }

  async attachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    if (permissionIds.length === 0 || !Types.ObjectId.isValid(roleId)) return;
    await this.models.Role.updateOne(
      { _id: roleId },
      {
        $addToSet: {
          permissionIds: {
            $each: permissionIds.map((id) => new Types.ObjectId(id)),
          },
        },
      },
    );
  }

  /** The mirror of `attachPermissions`: `$pull` of a grant the role does not hold is a no-op. */
  async detachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    if (permissionIds.length === 0 || !Types.ObjectId.isValid(roleId)) return;
    await this.models.Role.updateOne(
      { _id: roleId },
      {
        $pull: {
          permissionIds: {
            $in: permissionIds.map((id) => new Types.ObjectId(id)),
          },
        },
      },
    );
  }

  async listPermissions(roleId: string): Promise<Permission[]> {
    if (!Types.ObjectId.isValid(roleId)) return [];
    const role = await this.models.Role.findById(roleId).lean();
    if (role === null || role.permissionIds.length === 0) return [];

    const docs = await this.models.Permission.find({
      _id: { $in: role.permissionIds },
    }).lean();
    return docs.map(toPermission);
  }

  /**
   * MongoDB cannot cascade a delete, so this is where `user_roles` and
   * `role_permissions` cleanup happens — the job the Postgres FKs do in the other adapters.
   */
  async delete(id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    const roleId = new Types.ObjectId(id);
    await this.models.Role.deleteOne({ _id: roleId });
    await this.models.User.updateMany({ roleIds: roleId }, { $pull: { roleIds: roleId } });
  }
}

function toRole(row: RoleDocument): Role {
  return {
    id: row._id.toString(),
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
  };
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
