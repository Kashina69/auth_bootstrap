import type { Pool } from 'pg';
import { createDrizzleClient, type DrizzleDb } from '../../../src/database/drizzle/client.js';
import { DrizzlePermissionRepository } from '../../../src/database/repositories/drizzle-permission.repository.js';
import { DrizzleRefreshTokenRepository } from '../../../src/database/repositories/drizzle-refresh-token.repository.js';
import { DrizzleRoleRepository } from '../../../src/database/repositories/drizzle-role.repository.js';
import { DrizzleUserRepository } from '../../../src/database/repositories/drizzle-user.repository.js';
import type { ContractHarness } from '../repository-contract.js';
import { createPostgresAdmin } from './postgres-admin.js';

/** Drizzle adapter against the real Postgres schema, migrated from `migrations/**`. */
export async function createDrizzleHarness(): Promise<ContractHarness> {
  const url = databaseUrl();
  const admin = await createPostgresAdmin(url);
  await admin.migrate();

  const db = createDrizzleClient(url);
  const pool = drizzlePool(db);

  return {
    users: new DrizzleUserRepository(db),
    roles: new DrizzleRoleRepository(db),
    permissions: new DrizzlePermissionRepository(db),
    refreshTokens: new DrizzleRefreshTokenRepository(db),
    reset: () => admin.truncate(),
    softDeleteUser: (id) => admin.softDeleteUser(id),
    dumpRefreshTokens: () => admin.dumpRefreshTokens(),
    close: async () => {
      await pool.end();
      await admin.close();
    },
  };
}

// `$client` is the real pg Pool at runtime but is missing from this drizzle version's
// `NodePgDatabase` type, and leaving the Pool open keeps the vitest worker alive.
function drizzlePool(db: DrizzleDb): Pool {
  return (db as unknown as { $client: Pool }).$client;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DATABASE_URL is not set for the contract suite');
  return url;
}
