import { Schema, Types } from 'mongoose';

export interface RoleDocument {
  _id: Types.ObjectId;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** `role_permissions` join table, embedded — see ../README.md for the mapping. */
  permissionIds: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

export const roleSchema = new Schema<RoleDocument>(
  {
    name: { type: String, required: true, unique: true },
    description: { type: String, default: null },
    isSystem: { type: Boolean, required: true, default: false },
    permissionIds: {
      type: [Schema.Types.ObjectId],
      required: true,
      default: [],
    },
  },
  { timestamps: true, collection: 'roles' },
);
