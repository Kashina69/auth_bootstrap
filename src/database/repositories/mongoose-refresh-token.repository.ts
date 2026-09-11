import { Types, type Connection } from 'mongoose';
import { mongooseModels, type MongooseModels } from '../mongoose/connection.js';
import type { RefreshTokenDocument } from '../mongoose/schemas/refresh-token.schema.js';
import type { RefreshTokenCreate, RefreshTokenRecord, RefreshTokenRepository } from './refresh-token.repository.js';

export class MongooseRefreshTokenRepository implements RefreshTokenRepository {
  private readonly models: MongooseModels;

  constructor(connection: Connection) {
    this.models = mongooseModels(connection);
  }

  async create(data: RefreshTokenCreate): Promise<void> {
    await this.models.RefreshToken.create({
      userId: new Types.ObjectId(data.userId),
      tokenHash: data.tokenHash,
      familyId: data.familyId,
      userAgent: data.userAgent,
      ip: data.ip,
      expiresAt: data.expiresAt,
    });
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const doc = await this.models.RefreshToken.findOne({
      tokenHash,
    }).lean();
    return doc === null ? null : toRefreshToken(doc);
  }

  async markRevoked(id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    await this.models.RefreshToken.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.models.RefreshToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) return;
    await this.models.RefreshToken.updateMany(
      { userId: new Types.ObjectId(userId), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }
}

function toRefreshToken(row: RefreshTokenDocument): RefreshTokenRecord {
  return {
    id: row._id.toString(),
    userId: row.userId.toString(),
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    userAgent: row.userAgent,
    ip: row.ip,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
