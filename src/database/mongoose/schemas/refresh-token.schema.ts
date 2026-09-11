import { Schema, Types } from 'mongoose';

export interface RefreshTokenDocument {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** SHA-256 of the raw token — the raw value is never persisted. */
  tokenHash: string;
  /** Groups every token descended from one login, for reuse-detection revocation. */
  familyId: string;
  userAgent: string;
  ip: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export const refreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    userAgent: { type: String, required: true },
    ip: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'refresh_tokens',
  },
);
