import { Types, type Connection } from 'mongoose';
import { mongooseModels, type MongooseModels } from '../mongoose/connection.js';
import type { UserDocument } from '../mongoose/schemas/user.schema.js';
import type { User, UserRepository } from './user.repository.js';

export class MongooseUserRepository implements UserRepository {
  private readonly models: MongooseModels;

  constructor(connection: Connection) {
    this.models = mongooseModels(connection);
  }

  async findById(id: string): Promise<User | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await this.models.User.findOne({ _id: id, deletedAt: null }).lean();
    return doc === null ? null : toUser(doc);
  }

  async findByEmail(email: string): Promise<User | null> {
    const doc = await this.models.User.findOne({
      email: normalizeEmail(email),
      deletedAt: null,
    }).lean();
    return doc === null ? null : toUser(doc);
  }

  async create(data: { email: string; passwordHash: string }): Promise<User> {
    const doc = await this.models.User.create({
      email: normalizeEmail(data.email),
      passwordHash: data.passwordHash,
    });
    return toUser(doc.toObject());
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    await this.models.User.updateOne({ _id: id }, { $set: { passwordHash } });
  }

  async assignRole(userId: string, roleId: string): Promise<void> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(roleId)) return;
    await this.models.User.updateOne({ _id: userId }, { $addToSet: { roleIds: roleId } });
  }

  async findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }> {
    if (!Types.ObjectId.isValid(id)) return { roles: [], permissions: [] };

    const user = await this.models.User.findById(id).lean();
    if (user === null || user.roleIds.length === 0) return { roles: [], permissions: [] };

    const roles = await this.models.Role.find({
      _id: { $in: user.roleIds },
    }).lean();
    const permissionIds = roles.flatMap((role) => role.permissionIds);
    const permissions =
      permissionIds.length === 0
        ? []
        : await this.models.Permission.find({
            _id: { $in: permissionIds },
          }).lean();

    return {
      roles: dedupe(roles.map((role) => role.name)),
      permissions: dedupe(permissions.map((permission) => `${permission.action}:${permission.subject}`)),
    };
  }

  /** The embedded `user_roles` join table is the `roleIds` array, so this is a reverse lookup. */
  async findUserIdsByRole(roleId: string): Promise<string[]> {
    if (!Types.ObjectId.isValid(roleId)) return [];
    const users = await this.models.User.find({ roleIds: roleId }).select({ _id: 1 }).lean();
    return users.map((user) => user._id.toString());
  }
}

/** Stands in for `citext`: the stored value is lowercase, so the lookup must be too. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUser(row: UserDocument): User {
  return {
    id: row._id.toString(),
    email: row.email,
    passwordHash: row.passwordHash,
    isActive: row.isActive,
    isEmailVerified: row.isEmailVerified,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
