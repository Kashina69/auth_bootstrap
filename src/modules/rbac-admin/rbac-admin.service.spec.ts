import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Permission, PermissionRepository } from '../../database/repositories/permission.repository.js';
import type { Role, RoleRepository } from '../../database/repositories/role.repository.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import type { IAuthorizationProvider } from '../../rbac-strategies/authorization-provider.interface.js';
import type { CreateRoleDto } from './dto/index.js';
import { RbacAdminService } from './rbac-admin.service.js';

const SYSTEM_ROLE: Role = { id: 'r-admin', name: 'admin', description: null, isSystem: true };
const CUSTOM_ROLE: Role = { id: 'r-editor', name: 'editor', description: null, isSystem: false };
const MANAGE_USER: Permission = {
  id: 'p-manage-user',
  action: 'manage',
  subject: 'User',
  name: 'manage:User',
  description: null,
  isSystem: true,
};
const READ_POST: Permission = {
  id: 'p-read-post',
  action: 'read',
  subject: 'Post',
  name: 'read:Post',
  description: null,
  isSystem: true,
};
// Declared by the seed's `permissions[]`, granted to no system role at all — the case the
// "granted by an isSystem role" heuristic got wrong (plan.md §5.4, MEMORY.md F1).
const UPDATE_POST: Permission = {
  id: 'p-update-post',
  action: 'update',
  subject: 'Post',
  name: 'update:Post',
  description: null,
  isSystem: true,
};
const RUNTIME_PERMISSION: Permission = {
  id: 'p-read-invoice',
  action: 'read',
  subject: 'Invoice',
  name: 'read:Invoice',
  description: null,
  isSystem: false,
};

const HOLDERS = ['u1', 'u2'];

interface Calls {
  invalidated: string[];
  deletedRoles: string[];
  deletedPermissions: string[];
  attached: Array<{ roleId: string; permissionIds: string[] }>;
  detached: Array<{ roleId: string; permissionIds: string[] }>;
  assigned: Array<{ userId: string; roleId: string }>;
  events: string[]; // ordered, so `deleteRole` can be pinned to reading holders first
}

function createService(calls: Calls, roles: Role[] = [SYSTEM_ROLE, CUSTOM_ROLE]): RbacAdminService {
  const permissions = [MANAGE_USER, READ_POST, UPDATE_POST, RUNTIME_PERMISSION];
  const grants: Record<string, Permission[]> = {
    [SYSTEM_ROLE.id]: [MANAGE_USER],
    [CUSTOM_ROLE.id]: [READ_POST],
  };

  const roleRepo: RoleRepository = {
    findById: async (id) => roles.find((role) => role.id === id) ?? null,
    findByName: async (name) => roles.find((role) => role.name === name) ?? null,
    findAll: async () => roles,
    create: async (data) => ({
      id: `r-${data.name}`,
      name: data.name,
      description: data.description ?? null,
      isSystem: data.isSystem ?? false,
    }),
    attachPermissions: async (roleId, permissionIds) => void calls.attached.push({ roleId, permissionIds }),
    detachPermissions: async (roleId, permissionIds) => {
      calls.detached.push({ roleId, permissionIds });
      grants[roleId] = (grants[roleId] ?? []).filter((held) => !permissionIds.includes(held.id));
    },
    listPermissions: async (roleId) => grants[roleId] ?? [],
    delete: async (id) => {
      calls.events.push('delete-role');
      calls.deletedRoles.push(id);
    },
  };

  const permissionRepo: PermissionRepository = {
    findById: async (id) => permissions.find((permission) => permission.id === id) ?? null,
    findByName: async (name) => permissions.find((permission) => permission.name === name) ?? null,
    findAll: async () => permissions,
    create: async (data) => ({
      id: `p-${data.action}-${data.subject}`,
      action: data.action,
      subject: data.subject,
      name: `${data.action}:${data.subject}`,
      description: data.description ?? null,
      isSystem: data.isSystem ?? false,
    }),
    delete: async (id) => void calls.deletedPermissions.push(id),
  };

  const userRepo = {
    findById: async (id: string) => (id === 'u1' ? { id } : null),
    assignRole: async (userId: string, roleId: string) => void calls.assigned.push({ userId, roleId }),
    findUserIdsByRole: async (roleId: string) => {
      calls.events.push('read-holders');
      return roleId === CUSTOM_ROLE.id ? HOLDERS : [];
    },
  } as unknown as UserRepository;
  const authz: IAuthorizationProvider = {
    getContext: async () => ({ roles: [], permissions: [] }),
    invalidate: async (userId) => void calls.invalidated.push(userId),
  };

  return new RbacAdminService(roleRepo, permissionRepo, userRepo, authz);
}

function emptyCalls(): Calls {
  return {
    invalidated: [],
    deletedRoles: [],
    deletedPermissions: [],
    attached: [],
    detached: [],
    assigned: [],
    events: [],
  };
}

describe('RbacAdminService', () => {
  it('refuses a role name that already exists', async () => {
    await expect(createService(emptyCalls()).createRole({ name: 'editor' })).rejects.toThrow(ConflictException);
  });

  it('creates a role as non-system even when the caller forges isSystem', async () => {
    const service = createService(emptyCalls());
    const forged = { name: 'auditor', isSystem: true } as unknown as CreateRoleDto;
    await expect(service.createRole(forged)).resolves.toMatchObject({ name: 'auditor', isSystem: false });
  });

  it('refuses to delete a system role, without touching the store', async () => {
    const calls = emptyCalls();
    await expect(createService(calls).deleteRole(SYSTEM_ROLE.id)).rejects.toThrow(ForbiddenException);
    expect(calls.deletedRoles).toEqual([]);
  });

  it('deletes a custom role, reading its holders before the relation is gone', async () => {
    const calls = emptyCalls();
    await createService(calls).deleteRole(CUSTOM_ROLE.id);
    expect(calls.deletedRoles).toEqual([CUSTOM_ROLE.id]);
    expect(calls.events).toEqual(['read-holders', 'delete-role']);
    expect(calls.invalidated).toEqual(HOLDERS);
  });

  it('refuses to delete a permission the baseline grants a system role', async () => {
    const calls = emptyCalls();
    await expect(createService(calls).deletePermission(MANAGE_USER.id)).rejects.toThrow(ForbiddenException);
    expect(calls.deletedPermissions).toEqual([]);
  });

  it('refuses to delete a declared baseline permission no system role grants', async () => {
    const calls = emptyCalls();
    await expect(createService(calls).deletePermission(UPDATE_POST.id)).rejects.toThrow(ForbiddenException);
    expect(calls.deletedPermissions).toEqual([]);
  });

  it('deletes a permission created at runtime', async () => {
    const calls = emptyCalls();
    await createService(calls).deletePermission(RUNTIME_PERMISSION.id);
    expect(calls.deletedPermissions).toEqual([RUNTIME_PERMISSION.id]);
  });

  it('resolves "action:subject" names to ids when attaching', async () => {
    const calls = emptyCalls();
    await createService(calls).attachPermissions(CUSTOM_ROLE.id, { permissions: ['read:Post', 'read:Post'] });
    expect(calls.attached).toEqual([{ roleId: CUSTOM_ROLE.id, permissionIds: [READ_POST.id] }]);
  });

  it('invalidates every holder of the role it attached to', async () => {
    const calls = emptyCalls();
    await createService(calls).attachPermissions(CUSTOM_ROLE.id, { permissions: ['update:Post'] });
    expect(calls.invalidated).toEqual(HOLDERS);
  });

  it('detaches a grant, invalidates its holders, and a repeated detach is a no-op', async () => {
    const calls = emptyCalls();
    const service = createService(calls);
    const detach = () => service.detachPermissions(CUSTOM_ROLE.id, { permissions: ['read:Post'] });

    await expect(detach()).resolves.toEqual([]);
    await expect(detach()).resolves.toEqual([]);

    expect(calls.detached).toEqual([
      { roleId: CUSTOM_ROLE.id, permissionIds: [READ_POST.id] },
      { roleId: CUSTOM_ROLE.id, permissionIds: [READ_POST.id] },
    ]);
    expect(calls.invalidated).toEqual([...HOLDERS, ...HOLDERS]);
  });

  it('reports every unknown permission name at once', async () => {
    const service = createService(emptyCalls());
    await expect(
      service.attachPermissions(CUSTOM_ROLE.id, { permissions: ['read:Nope', 'write:Nope'] }),
    ).rejects.toThrow(new NotFoundException('Unknown permission(s): read:Nope, write:Nope'));
  });

  it('assigns the resolved role and invalidates exactly that user', async () => {
    const calls = emptyCalls();
    await createService(calls).assignRoleToUser('u1', { roleId: CUSTOM_ROLE.id });
    expect(calls.assigned).toEqual([{ userId: 'u1', roleId: CUSTOM_ROLE.id }]);
    expect(calls.invalidated).toEqual(['u1']);
  });

  it('rejects an assignment to an unknown role', async () => {
    const calls = emptyCalls();
    await expect(createService(calls).assignRoleToUser('u1', { roleId: 'nope' })).rejects.toThrow(NotFoundException);
    expect(calls.invalidated).toEqual([]);
  });
});
