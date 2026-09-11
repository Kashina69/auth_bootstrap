import { Global, Module, type DynamicModule } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Connection } from 'mongoose';
import type { Sequelize } from 'sequelize';
import {
  DB_CLIENT,
  PERMISSION_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  ROLE_REPOSITORY,
  USER_REPOSITORY,
} from '../common/constants.js';
import { AppConfig } from '../config/app-config.service.js';
import { createDrizzleClient, type DrizzleDb } from './drizzle/client.js';
import { createMongooseClient } from './mongoose/connection.js';
import { createSequelizeClient } from './sequelize/init.js';
import { DrizzlePermissionRepository } from './repositories/drizzle-permission.repository.js';
import { DrizzleRefreshTokenRepository } from './repositories/drizzle-refresh-token.repository.js';
import { DrizzleRoleRepository } from './repositories/drizzle-role.repository.js';
import { DrizzleUserRepository } from './repositories/drizzle-user.repository.js';
import { MongoosePermissionRepository } from './repositories/mongoose-permission.repository.js';
import { MongooseRefreshTokenRepository } from './repositories/mongoose-refresh-token.repository.js';
import { MongooseRoleRepository } from './repositories/mongoose-role.repository.js';
import { MongooseUserRepository } from './repositories/mongoose-user.repository.js';
import type { PermissionRepository } from './repositories/permission.repository.js';
import { PrismaPermissionRepository } from './repositories/prisma-permission.repository.js';
import { PrismaRefreshTokenRepository } from './repositories/prisma-refresh-token.repository.js';
import { PrismaRoleRepository } from './repositories/prisma-role.repository.js';
import { PrismaUserRepository } from './repositories/prisma-user.repository.js';
import type { RefreshTokenRepository } from './repositories/refresh-token.repository.js';
import type { RoleRepository } from './repositories/role.repository.js';
import { SequelizePermissionRepository } from './repositories/sequelize-permission.repository.js';
import { SequelizeRefreshTokenRepository } from './repositories/sequelize-refresh-token.repository.js';
import { SequelizeRoleRepository } from './repositories/sequelize-role.repository.js';
import { SequelizeUserRepository } from './repositories/sequelize-user.repository.js';
import type { UserRepository } from './repositories/user.repository.js';

type DbClient = PrismaClient | DrizzleDb | Sequelize | Connection;

/**
 * Selects the data layer at DI-registration time, exactly like the auth/RBAC strategy
 * switch in plan.md §3 — `DB_PROVIDER` is read once at boot and every consumer
 * downstream injects only the frozen repository tokens (CONTRACTS.md §1).
 *
 * All four adapters (prisma, drizzle, sequelize, mongoose) implement the same frozen
 * repository interfaces, so this switch is the single place a concrete class is chosen.
 */
@Global()
@Module({})
export class DatabaseModule {
  static register(): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DB_CLIENT,
          useFactory: createDbClient,
          inject: [AppConfig],
        },
        {
          provide: USER_REPOSITORY,
          useFactory: createUserRepository,
          inject: [AppConfig, DB_CLIENT],
        },
        {
          provide: ROLE_REPOSITORY,
          useFactory: createRoleRepository,
          inject: [AppConfig, DB_CLIENT],
        },
        {
          provide: PERMISSION_REPOSITORY,
          useFactory: createPermissionRepository,
          inject: [AppConfig, DB_CLIENT],
        },
        {
          provide: REFRESH_TOKEN_REPOSITORY,
          useFactory: createRefreshTokenRepository,
          inject: [AppConfig, DB_CLIENT],
        },
      ],
      exports: [USER_REPOSITORY, ROLE_REPOSITORY, PERMISSION_REPOSITORY, REFRESH_TOKEN_REPOSITORY],
    };
  }
}

function createDbClient(config: AppConfig): DbClient | Promise<Connection> {
  switch (config.DB_PROVIDER) {
    case 'prisma':
      return new PrismaClient({ datasourceUrl: config.DATABASE_URL });
    case 'drizzle':
      return createDrizzleClient(config.DATABASE_URL);
    case 'sequelize':
      return createSequelizeClient(config.DATABASE_URL);
    case 'mongoose':
      // `createMongooseClient` is async; Nest resolves the returned promise before
      // injecting DB_CLIENT downstream, so repositories always receive a live Connection.
      return createMongooseClient(config.DATABASE_URL);
  }
}

function createUserRepository(config: AppConfig, client: DbClient): UserRepository {
  switch (config.DB_PROVIDER) {
    case 'prisma':
      return new PrismaUserRepository(client as PrismaClient);
    case 'drizzle':
      return new DrizzleUserRepository(client as DrizzleDb);
    case 'sequelize':
      return new SequelizeUserRepository(client as Sequelize);
    case 'mongoose':
      return new MongooseUserRepository(client as Connection);
  }
}

function createRoleRepository(config: AppConfig, client: DbClient): RoleRepository {
  switch (config.DB_PROVIDER) {
    case 'prisma':
      return new PrismaRoleRepository(client as PrismaClient);
    case 'drizzle':
      return new DrizzleRoleRepository(client as DrizzleDb);
    case 'sequelize':
      return new SequelizeRoleRepository(client as Sequelize);
    case 'mongoose':
      return new MongooseRoleRepository(client as Connection);
  }
}

function createPermissionRepository(config: AppConfig, client: DbClient): PermissionRepository {
  switch (config.DB_PROVIDER) {
    case 'prisma':
      return new PrismaPermissionRepository(client as PrismaClient);
    case 'drizzle':
      return new DrizzlePermissionRepository(client as DrizzleDb);
    case 'sequelize':
      return new SequelizePermissionRepository(client as Sequelize);
    case 'mongoose':
      return new MongoosePermissionRepository(client as Connection);
  }
}

function createRefreshTokenRepository(
  config: AppConfig,
  client: DbClient,
): RefreshTokenRepository {
  switch (config.DB_PROVIDER) {
    case 'prisma':
      return new PrismaRefreshTokenRepository(client as PrismaClient);
    case 'drizzle':
      return new DrizzleRefreshTokenRepository(client as DrizzleDb);
    case 'sequelize':
      return new SequelizeRefreshTokenRepository(client as Sequelize);
    case 'mongoose':
      return new MongooseRefreshTokenRepository(client as Connection);
  }
}
