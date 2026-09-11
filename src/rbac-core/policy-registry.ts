import type { AuthzContext } from './types.js';

export type RolePermissionMap = Record<string, string[]>;

export interface PolicyRegistry {
  resolveContext(roles: string[]): AuthzContext;
}

export function createPolicyRegistry(rolePermissions: RolePermissionMap): PolicyRegistry {
  return {
    resolveContext(roles: string[]): AuthzContext {
      return { roles: [...roles], permissions: collectPermissions(rolePermissions, roles) };
    },
  };
}

function collectPermissions(rolePermissions: RolePermissionMap, roles: string[]): string[] {
  const permissions = new Set<string>();
  for (const role of roles) {
    for (const permission of rolePermissions[role] ?? []) permissions.add(permission);
  }
  return [...permissions];
}
