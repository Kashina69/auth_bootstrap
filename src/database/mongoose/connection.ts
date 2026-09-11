import mongoose, { type Connection, type Model } from 'mongoose';
import {
  permissionSchema,
  refreshTokenSchema,
  roleSchema,
  userSchema,
  type PermissionDocument,
  type RefreshTokenDocument,
  type RoleDocument,
  type UserDocument,
} from './schemas/index.js';

export interface MongooseModels {
  User: Model<UserDocument>;
  Role: Model<RoleDocument>;
  Permission: Model<PermissionDocument>;
  RefreshToken: Model<RefreshTokenDocument>;
}

/**
 * The single entry point `DatabaseModule` uses when `DB_PROVIDER=mongoose`. Returns the
 * connection (the Mongoose analogue of the other adapters' db client) with the four
 * collections registered on it, so repositories never reach through the global
 * mongoose singleton.
 */
export async function createMongooseClient(uri: string): Promise<Connection> {
  const connection = mongoose.createConnection(uri);
  await connection.asPromise();
  return registerMongooseModels(connection);
}

export function registerMongooseModels(connection: Connection): Connection {
  connection.model('User', userSchema);
  connection.model('Role', roleSchema);
  connection.model('Permission', permissionSchema);
  connection.model('RefreshToken', refreshTokenSchema);
  return connection;
}

/** Collection names live here only, so a repository can never drift from the registry. */
export function mongooseModels(connection: Connection): MongooseModels {
  return {
    User: connection.model<UserDocument>('User'),
    Role: connection.model<RoleDocument>('Role'),
    Permission: connection.model<PermissionDocument>('Permission'),
    RefreshToken: connection.model<RefreshTokenDocument>('RefreshToken'),
  };
}
