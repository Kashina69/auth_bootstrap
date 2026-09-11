import { Op, type Sequelize } from 'sequelize';
import {
  PermissionModel,
  RoleModel,
  RolePermissionModel,
  UserModel,
  UserRoleModel,
} from '../sequelize/models/index.js';
import { sequelizeModels } from '../sequelize/init.js';
import type { User, UserRepository } from './user.repository.js';

export class SequelizeUserRepository implements UserRepository {
  private readonly userModel: typeof UserModel;

  constructor(sequelize: Sequelize) {
    this.userModel = sequelizeModels(sequelize).User;
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.userModel.findOne({ where: { id, deletedAt: null } });
    return row === null ? null : toUser(row);
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.userModel.findOne({ where: { email, deletedAt: null } });
    return row === null ? null : toUser(row);
  }

  async create(data: { email: string; passwordHash: string }): Promise<User> {
    const row = await this.userModel.create({
      email: data.email,
      passwordHash: data.passwordHash,
    });
    return toUser(row);
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.userModel.update({ passwordHash }, { where: { id } });
  }

  async assignRole(userId: string, roleId: string): Promise<void> {
    await UserRoleModel.findOrCreate({ where: { userId, roleId } });
  }

  async findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }> {
    const assignments = await UserRoleModel.findAll({
      where: { userId: id },
    });
    const roleIds = assignments.map((assignment) => assignment.roleId);
    if (roleIds.length === 0) return { roles: [], permissions: [] };

    const roles = await RoleModel.findAll({
      where: { id: { [Op.in]: roleIds } },
    });
    const links = await RolePermissionModel.findAll({
      where: { roleId: { [Op.in]: roleIds } },
    });
    const permissionIds = links.map((link) => link.permissionId);
    const permissions =
      permissionIds.length === 0
        ? []
        : await PermissionModel.findAll({
            where: { id: { [Op.in]: permissionIds } },
          });

    return {
      roles: dedupe(roles.map((role) => role.name)),
      permissions: dedupe(permissions.map((permission) => `${permission.action}:${permission.subject}`)),
    };
  }
}

function toUser(row: UserModel): User {
  return {
    id: row.id,
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
