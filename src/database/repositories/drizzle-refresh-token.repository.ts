import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '../drizzle/client.js';
import { refreshTokens } from '../drizzle/schema.js';
import type { RefreshTokenCreate, RefreshTokenRecord, RefreshTokenRepository } from './refresh-token.repository.js';

export class DrizzleRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(data: RefreshTokenCreate): Promise<void> {
    await this.db.insert(refreshTokens).values(data);
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const [row] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
    return row ?? null;
  }

  async markRevoked(id: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}
