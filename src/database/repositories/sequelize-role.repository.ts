import { Op, type Sequelize } from 'sequelize';
import { PermissionModel, RoleModel, RolePermissionModel } from '../sequelize/models/index.js';
import { sequelizeModels } from '../sequelize/init.js';
import type { Permission } from './permission.repository.js';
import type { Role, RoleRepository } from './role.repository.js';

export class SequelizeRoleRepository implements RoleRepository {
  private readonly roleModel: typeof RoleModel;

  constructor(sequelize: Sequelize) {
    this.roleModel = sequelizeModels(sequelize).Role;
  }

  async findById(id: string): Promise<Role | null> {
    const row = await this.roleModel.findByPk(id);
    return row === null ? null : toRole(row);
  }

  async findByName(name: string): Promise<Role | null> {
    const row = await this.roleModel.findOne({ where: { name } });
    return row === null ? null : toRole(row);
  }

  async findAll(): Promise<Role[]> {
    const rows = await this.roleModel.findAll({ order: [['name', 'ASC']] });
    return rows.map(toRole);
  }

  async create(data: { name: string; description?: string; isSystem?: boolean }): Promise<Role> {
    const row = await this.roleModel.create({
      name: data.name,
      description: data.description ?? null,
      isSystem: data.isSystem ?? false,
    });
    return toRole(row);
  }

  async attachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    if (permissionIds.length === 0) return;
    await RolePermissionModel.bulkCreate(
      permissionIds.map((permissionId) => ({ roleId, permissionId })),
      { ignoreDuplicates: true },
    );
  }

  async listPermissions(roleId: string): Promise<Permission[]> {
    const links = await RolePermissionModel.findAll({ where: { roleId } });
    const permissionIds = links.map((link) => link.permissionId);
    if (permissionIds.length === 0) return [];

    const rows = await PermissionModel.findAll({
      where: { id: { [Op.in]: permissionIds } },
    });
    return rows.map(toPermission);
  }

  async delete(id: string): Promise<void> {
    await this.roleModel.destroy({ where: { id } });
  }
}

function toRole(row: RoleModel): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
  };
}

function toPermission(row: PermissionModel): Permission {
  return {
    id: row.id,
    action: row.action,
    subject: row.subject,
    name: row.name,
    description: row.description,
  };
}
