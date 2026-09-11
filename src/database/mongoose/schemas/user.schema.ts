import { Schema, Types } from 'mongoose';

export interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  isActive: boolean;
  isEmailVerified: boolean;
  /** `user_roles` join table, embedded — see ../README.md for the mapping. */
  roleIds: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * `email` replaces the source schema's `citext`: MongoDB has no case-insensitive text
 * type, so the value is normalized to lowercase on the way in and on the way out.
 */
export const userSchema = new Schema<UserDocument>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    isActive: { type: Boolean, required: true, default: true },
    isEmailVerified: { type: Boolean, required: true, default: false },
    roleIds: { type: [Schema.Types.ObjectId], required: true, default: [] },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'users' },
);
