import { Types } from 'mongoose';
import { createMongooseClient, mongooseModels } from '../../../src/database/mongoose/connection.js';
import { MongoosePermissionRepository } from '../../../src/database/repositories/mongoose-permission.repository.js';
import { MongooseRefreshTokenRepository } from '../../../src/database/repositories/mongoose-refresh-token.repository.js';
import { MongooseRoleRepository } from '../../../src/database/repositories/mongoose-role.repository.js';
import { MongooseUserRepository } from '../../../src/database/repositories/mongoose-user.repository.js';
import type { ContractHarness } from '../repository-contract.js';

/** Mongoose adapter against a real MongoDB — no DDL, the collections are implicit. */
export async function createMongooseHarness(): Promise<ContractHarness> {
  const connection = await createMongooseClient(mongoUrl());
  const models = mongooseModels(connection);

  return {
    users: new MongooseUserRepository(connection),
    roles: new MongooseRoleRepository(connection),
    permissions: new MongoosePermissionRepository(connection),
    refreshTokens: new MongooseRefreshTokenRepository(connection),
    reset: async () => {
      await Promise.all([
        models.User.deleteMany({}),
        models.Role.deleteMany({}),
        models.Permission.deleteMany({}),
        models.RefreshToken.deleteMany({}),
      ]);
    },
    softDeleteUser: async (id: string) => {
      await models.User.updateOne({ _id: new Types.ObjectId(id) }, { $set: { deletedAt: new Date() } });
    },
    dumpRefreshTokens: async () => {
      const docs = await models.RefreshToken.find().lean();
      return JSON.stringify(docs);
    },
    close: async () => {
      await connection.close();
    },
  };
}

function mongoUrl(): string {
  const url = process.env.MONGO_URL;
  if (url === undefined) throw new Error('MONGO_URL is not set for the contract suite');
  return url;
}
