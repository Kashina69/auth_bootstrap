import { Sequelize } from 'sequelize';
import {
  PermissionModel,
  RefreshTokenModel,
  RoleModel,
  RolePermissionModel,
  UserModel,
  UserRoleModel,
  initPermissionModel,
  initRefreshTokenModel,
  initRoleModel,
  initRolePermissionModel,
  initUserModel,
  initUserRoleModel,
} from './models/index.js';

export interface SequelizeModels {
  User: typeof UserModel;
  Role: typeof RoleModel;
  Permission: typeof PermissionModel;
  RolePermission: typeof RolePermissionModel;
  UserRole: typeof UserRoleModel;
  RefreshToken: typeof RefreshTokenModel;
}

/**
 * Binds the six model classes to one connection. The models themselves are
 * module-level classes (Sequelize's own singleton shape), so a repository reaches them
 * through the connection it was handed rather than importing the class directly.
 */
export function initSequelizeModels(sequelize: Sequelize): SequelizeModels {
  initUserModel(sequelize);
  initRoleModel(sequelize);
  initPermissionModel(sequelize);
  initRolePermissionModel(sequelize);
  initUserRoleModel(sequelize);
  initRefreshTokenModel(sequelize);

  return sequelizeModels(sequelize);
}

/** Reads the connection's model registry back out with the concrete model types. */
export function sequelizeModels(sequelize: Sequelize): SequelizeModels {
  return sequelize.models as unknown as SequelizeModels;
}

/**
 * The single entry point `DatabaseModule` uses when `DB_PROVIDER=sequelize`. Migrations
 * stay with Sequelize's own tooling — this unifies the runtime query layer only.
 */
export function createSequelizeClient(databaseUrl: string): Sequelize {
  const sequelize = new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: false,
  });
  initSequelizeModels(sequelize);
  return sequelize;
}
