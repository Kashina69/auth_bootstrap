import { Schema, Types } from 'mongoose';

export interface PermissionDocument {
  _id: Types.ObjectId;
  action: string;
  subject: string;
  /** Generated `"{action}:{subject}"` — the string `rbac-core.can()` checks against. */
  name: string;
  description: string | null;
  createdAt: Date;
}

export const permissionSchema = new Schema<PermissionDocument>(
  {
    action: { type: String, required: true },
    subject: { type: String, required: true },
    name: { type: String, required: true, unique: true },
    description: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'permissions',
  },
);
