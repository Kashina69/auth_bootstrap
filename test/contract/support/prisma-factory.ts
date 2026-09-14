import { PrismaClient } from '@prisma/client';
import { PrismaPermissionRepository } from '../../../src/database/repositories/prisma-permission.repository.js';
import { PrismaRefreshTokenRepository } from '../../../src/database/repositories/prisma-refresh-token.repository.js';
import { PrismaRoleRepository } from '../../../src/database/repositories/prisma-role.repository.js';
import { PrismaUserRepository } from '../../../src/database/repositories/prisma-user.repository.js';
import type { ContractHarness } from '../repository-contract.js';
import { createPostgresAdmin } from './postgres-admin.js';

/** Prisma adapter against the real Postgres schema, migrated from `migrations/**`. */
export async function createPrismaHarness(): Promise<ContractHarness> {
  const admin = await createPostgresAdmin(databaseUrl());
  await admin.migrate();

  const prisma = new PrismaClient();

  return {
    users: new PrismaUserRepository(prisma),
    roles: new PrismaRoleRepository(prisma),
    permissions: new PrismaPermissionRepository(prisma),
    refreshTokens: new PrismaRefreshTokenRepository(prisma),
    reset: () => admin.truncate(),
    softDeleteUser: (id) => admin.softDeleteUser(id),
    dumpRefreshTokens: () => admin.dumpRefreshTokens(),
    close: async () => {
      await prisma.$disconnect();
      await admin.close();
    },
  };
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DATABASE_URL is not set for the contract suite');
  return url;
}
