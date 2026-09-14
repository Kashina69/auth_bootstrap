/**
 * THE CONTRACT for role persistence — CONTRACTS.md §5, verbatim.
 *
 * `isSystem` marks the seeded baseline roles (`superadmin`/`admin`/`user`) that the
 * runtime RBAC admin API must refuse to delete (plan.md §4, §5).
 */

import type { Permission } from './permission.repository.js';

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

export interface RoleRepository {
  findById(id: string): Promise<Role | null>;
  findByName(name: string): Promise<Role | null>;
  findAll(): Promise<Role[]>;
  create(data: { name: string; description?: string; isSystem?: boolean }): Promise<Role>;
  attachPermissions(roleId: string, permissionIds: string[]): Promise<void>;
  detachPermissions(roleId: string, permissionIds: string[]): Promise<void>; // idempotent
  listPermissions(roleId: string): Promise<Permission[]>;
  delete(id: string): Promise<void>;
}
