import type { Sequelize } from 'sequelize';
import { PermissionModel } from '../sequelize/models/index.js';
import { sequelizeModels } from '../sequelize/init.js';
import type { Permission, PermissionRepository } from './permission.repository.js';

export class SequelizePermissionRepository implements PermissionRepository {
  private readonly permissionModel: typeof PermissionModel;

  constructor(sequelize: Sequelize) {
    this.permissionModel = sequelizeModels(sequelize).Permission;
  }

  async findById(id: string): Promise<Permission | null> {
    const row = await this.permissionModel.findByPk(id);
    return row === null ? null : toPermission(row);
  }

  async findByName(name: string): Promise<Permission | null> {
    const row = await this.permissionModel.findOne({ where: { name } });
    return row === null ? null : toPermission(row);
  }

  async findAll(): Promise<Permission[]> {
    const rows = await this.permissionModel.findAll({
      order: [['name', 'ASC']],
    });
    return rows.map(toPermission);
  }

  async create(data: { action: string; subject: string; description?: string }): Promise<Permission> {
    const row = await this.permissionModel.create({
      action: data.action,
      subject: data.subject,
      name: `${data.action}:${data.subject}`,
      description: data.description ?? null,
    });
    return toPermission(row);
  }

  async delete(id: string): Promise<void> {
    await this.permissionModel.destroy({ where: { id } });
  }
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
