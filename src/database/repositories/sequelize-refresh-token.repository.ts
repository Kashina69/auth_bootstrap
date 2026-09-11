import type { Sequelize } from 'sequelize';
import { RefreshTokenModel } from '../sequelize/models/index.js';
import { sequelizeModels } from '../sequelize/init.js';
import type { RefreshTokenCreate, RefreshTokenRecord, RefreshTokenRepository } from './refresh-token.repository.js';

export class SequelizeRefreshTokenRepository implements RefreshTokenRepository {
  private readonly tokenModel: typeof RefreshTokenModel;

  constructor(sequelize: Sequelize) {
    this.tokenModel = sequelizeModels(sequelize).RefreshToken;
  }

  async create(data: RefreshTokenCreate): Promise<void> {
    await this.tokenModel.create(data);
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await this.tokenModel.findOne({ where: { tokenHash } });
    return row === null ? null : toRefreshToken(row);
  }

  async markRevoked(id: string): Promise<void> {
    await this.tokenModel.update({ revokedAt: new Date() }, { where: { id, revokedAt: null } });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.tokenModel.update({ revokedAt: new Date() }, { where: { familyId, revokedAt: null } });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.tokenModel.update({ revokedAt: new Date() }, { where: { userId, revokedAt: null } });
  }
}

function toRefreshToken(row: RefreshTokenModel): RefreshTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    userAgent: row.userAgent,
    ip: row.ip,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
