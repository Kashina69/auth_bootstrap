import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { DEFAULT_JWT_REFRESH_TOKEN_TTL } from '../../config/constants.js';
import type {
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../../database/repositories/refresh-token.repository.js';

export interface RefreshTokenMeta {
  userAgent: string;
  ip: string;
}

export interface RotatedRefreshToken {
  userId: string;
  refreshToken: string;
}

/**
 * Opaque refresh tokens: issuance, rotation and reuse detection — implementation.spec.md §3,
 * implemented exactly. The raw value exists only in the return of `issue()`; everything
 * persisted is its SHA-256 hash, so a database leak yields no usable token.
 *
 * Not an `@Injectable()` provider — the strategy (which the frozen module factory builds
 * with `new`) owns the single instance, constructed from the injected repository.
 */
export class RefreshTokenService {
  constructor(private readonly refreshTokens: RefreshTokenRepository) {}

  /** `issue()` is the only moment the raw token exists; the caller returns it to the client. */
  async issue(userId: string, meta: RefreshTokenMeta, familyId?: string): Promise<string> {
    const rawToken = generateOpaqueToken();
    await this.refreshTokens.create({
      userId,
      tokenHash: hashToken(rawToken),
      familyId: familyId ?? randomUUID(), // one family per login, inherited by every rotation
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt: addTtl(new Date(), DEFAULT_JWT_REFRESH_TOKEN_TTL),
    });
    return rawToken;
  }

  /** Validates and rotates a refresh token; the security-critical function. */
  async rotate(rawToken: string, meta: RefreshTokenMeta): Promise<RotatedRefreshToken> {
    const record = await this.requireUsableRecord(rawToken);
    await this.refreshTokens.markRevoked(record.id);
    const refreshToken = await this.issue(record.userId, meta, record.familyId);
    return { userId: record.userId, refreshToken };
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId); // logout-everywhere / admin-forced logout
  }

  /** Lookup is by hash only — never fetch-and-compare raw tokens in application code. */
  private async requireUsableRecord(rawToken: string): Promise<RefreshTokenRecord> {
    const record = await this.refreshTokens.findByHash(hashToken(rawToken));
    if (!record) throw new UnauthorizedException('Invalid refresh token');
    await assertNotReused(record, this.refreshTokens);
    assertNotExpired(record);
    return record;
  }
}

/**
 * A token that was already rotated is being replayed: the only innocent explanation is a
 * lost race, the likely one is theft. Revoke the whole family — every token descended from
 * the same login — so neither the thief nor the victim keeps a usable session.
 */
async function assertNotReused(
  record: RefreshTokenRecord,
  refreshTokens: RefreshTokenRepository,
): Promise<void> {
  if (!record.revokedAt) return;
  await refreshTokens.revokeFamily(record.familyId);
  throw new UnauthorizedException('Refresh token reuse detected — all sessions revoked');
}

function assertNotExpired(record: RefreshTokenRecord): void {
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedException('Refresh token expired');
  }
}

function generateOpaqueToken(): string {
  return randomBytes(48).toString('base64url'); // 384 bits of entropy
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

const TTL_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `DEFAULT_JWT_REFRESH_TOKEN_TTL` ('30d') is the only TTL shape this has to understand. */
function addTtl(from: Date, ttl: string): Date {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) throw new Error(`Unsupported TTL "${ttl}" — expected e.g. "30d"`);
  return new Date(from.getTime() + Number(match[1]) * TTL_UNIT_MS[match[2]]);
}
