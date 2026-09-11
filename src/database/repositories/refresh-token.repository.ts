/**
 * THE CONTRACT for refresh-token persistence — CONTRACTS.md §5, verbatim.
 *
 * Security invariants (implementation.spec.md §2): the raw refresh token is NEVER
 * stored — only its SHA-256 hash. `familyId` groups a rotation chain so that reuse of an
 * already-rotated token can revoke the entire family in one call (`revokeFamily`).
 */

export interface RefreshTokenCreate {
  userId: string;
  tokenHash: string;
  familyId: string;
  userAgent: string;
  ip: string;
  expiresAt: Date;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  userAgent: string;
  ip: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface RefreshTokenRepository {
  create(data: RefreshTokenCreate): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  markRevoked(id: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}
