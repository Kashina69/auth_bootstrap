import { createSequelizeClient } from '../../../src/database/sequelize/init.js';
import { SequelizePermissionRepository } from '../../../src/database/repositories/sequelize-permission.repository.js';
import { SequelizeRefreshTokenRepository } from '../../../src/database/repositories/sequelize-refresh-token.repository.js';
import { SequelizeRoleRepository } from '../../../src/database/repositories/sequelize-role.repository.js';
import { SequelizeUserRepository } from '../../../src/database/repositories/sequelize-user.repository.js';
import type { ContractHarness } from '../repository-contract.js';
import { createPostgresAdmin } from './postgres-admin.js';

/**
 * Sequelize adapter against the real Postgres schema. The DDL comes from `migrations/**`,
 * not `sequelize.sync()` — `sync()` would build whatever the models say rather than what
 * production has, and the point of running this provider at all is to catch where the models
 * and the migrations disagree.
 *
 * `createPostgresAdmin().migrate()` applies the shipped migrations verbatim, so what this
 * adapter is verified against is the schema production has.
 */
export async function createSequelizeHarness(): Promise<ContractHarness> {
  const url = databaseUrl();
  const admin = await createPostgresAdmin(url);
  await admin.migrate();

  const sequelize = createSequelizeClient(url);

  return {
    users: new SequelizeUserRepository(sequelize),
    roles: new SequelizeRoleRepository(sequelize),
    permissions: new SequelizePermissionRepository(sequelize),
    refreshTokens: new SequelizeRefreshTokenRepository(sequelize),
    reset: () => admin.truncate(),
    softDeleteUser: (id) => admin.softDeleteUser(id),
    dumpRefreshTokens: () => admin.dumpRefreshTokens(),
    close: async () => {
      await sequelize.close();
      await admin.close();
    },
  };
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DATABASE_URL is not set for the contract suite');
  return url;
}
