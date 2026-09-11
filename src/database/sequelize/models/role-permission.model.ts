import { DataTypes, InferAttributes, InferCreationAttributes, Model, type Sequelize } from 'sequelize';

export class RolePermissionModel extends Model<
  InferAttributes<RolePermissionModel>,
  InferCreationAttributes<RolePermissionModel>
> {
  declare roleId: string;
  declare permissionId: string;
}

/** `role_permissions` join table — composite PK, no surrogate id, no timestamps. */
export function initRolePermissionModel(sequelize: Sequelize): typeof RolePermissionModel {
  RolePermissionModel.init(
    {
      roleId: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        field: 'role_id',
      },
      permissionId: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        field: 'permission_id',
      },
    },
    {
      sequelize,
      modelName: 'RolePermission',
      tableName: 'role_permissions',
      timestamps: false,
    },
  );
  return RolePermissionModel;
}
