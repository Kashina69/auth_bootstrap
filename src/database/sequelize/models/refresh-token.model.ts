import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  type Sequelize,
} from 'sequelize';

export class RefreshTokenModel extends Model<
  InferAttributes<RefreshTokenModel>,
  InferCreationAttributes<RefreshTokenModel>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare tokenHash: string;
  declare familyId: string;
  declare userAgent: string;
  declare ip: string;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

export function initRefreshTokenModel(sequelize: Sequelize): typeof RefreshTokenModel {
  RefreshTokenModel.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_id',
      },
      tokenHash: {
        type: DataTypes.TEXT,
        allowNull: false,
        unique: true,
        field: 'token_hash',
      },
      familyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'family_id',
      },
      userAgent: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'user_agent',
      },
      ip: { type: DataTypes.TEXT, allowNull: false },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
      },
      revokedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'revoked_at',
      },
      createdAt: { type: DataTypes.DATE, field: 'created_at' },
    },
    {
      sequelize,
      modelName: 'RefreshToken',
      tableName: 'refresh_tokens',
      timestamps: true,
      updatedAt: false,
    },
  );
  return RefreshTokenModel;
}
