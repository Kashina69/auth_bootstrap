import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  type Sequelize,
} from 'sequelize';

export class UserModel extends Model<InferAttributes<UserModel>, InferCreationAttributes<UserModel>> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare passwordHash: string;
  declare isActive: CreationOptional<boolean>;
  declare isEmailVerified: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

/**
 * `paranoid` is deliberately off: soft-delete filtering lives in the repository finders
 * (they add `deletedAt: null`), so the `deletedAt` column stays visible on returned
 * users. Email is plain text and case-normalized at the service boundary for
 * cross-ORM consistency (see `database/` README note).
 */
export function initUserModel(sequelize: Sequelize): typeof UserModel {
  UserModel.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      email: { type: DataTypes.STRING, allowNull: false, unique: true },
      passwordHash: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'password_hash',
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_active',
      },
      isEmailVerified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_email_verified',
      },
      createdAt: { type: DataTypes.DATE, field: 'created_at' },
      updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'deleted_at',
      },
    },
    { sequelize, modelName: 'User', tableName: 'users', timestamps: true },
  );
  return UserModel;
}
