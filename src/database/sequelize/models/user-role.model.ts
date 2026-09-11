import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  type Sequelize,
} from 'sequelize';

export class UserRoleModel extends Model<InferAttributes<UserRoleModel>, InferCreationAttributes<UserRoleModel>> {
  declare userId: string;
  declare roleId: string;
  declare assignedBy: string | null;
  declare assignedAt: CreationOptional<Date>;
}

/** `user_roles` join table — composite PK carrying the assignment audit columns. */
export function initUserRoleModel(sequelize: Sequelize): typeof UserRoleModel {
  UserRoleModel.init(
    {
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        field: 'user_id',
      },
      roleId: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        field: 'role_id',
      },
      assignedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'assigned_by',
      },
      assignedAt: { type: DataTypes.DATE, field: 'assigned_at' },
    },
    {
      sequelize,
      modelName: 'UserRole',
      tableName: 'user_roles',
      timestamps: false,
    },
  );
  return UserRoleModel;
}
