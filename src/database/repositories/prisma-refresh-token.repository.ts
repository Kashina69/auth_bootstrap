import type { Prisma, PrismaClient, RefreshToken as RefreshTokenRow } from '@prisma/client';
import type {
  RefreshTokenCreate,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from './refresh-token.repository.js';

/**
 * Prisma implementation of `RefreshTokenRepository`. Bound to the
 * `REFRESH_TOKEN_REPOSITORY` token by `DatabaseModule.register()` when
 * `DB_PROVIDER=prisma`.
 *
 * `create` takes only the hash — the raw token never reaches this layer
 * (implementation.spec.md §2). All three revocations filter on `revokedAt: null` so the
 * original revocation timestamp of an already-revoked row survives a repeat call.
 */
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: RefreshTokenCreate): Promise<void> {
    await this.prisma.refreshToken.create({
      data: {
        userId: data.userId,
        tokenHash: data.tokenHash,
        familyId: data.familyId,
        userAgent: data.userAgent,
        ip: data.ip,
        expiresAt: data.expiresAt,
      },
    });
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    return row === null ? null : toRefreshTokenRecord(row);
  }

  async markRevoked(id: string): Promise<void> {
    await this.revoke({ id });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.revoke({ familyId });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.revoke({ userId });
  }

  private async revoke(where: Prisma.RefreshTokenWhereInput): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

function toRefreshTokenRecord(row: RefreshTokenRow): RefreshTokenRecord {
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
