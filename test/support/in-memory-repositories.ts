import type { Permission, PermissionRepository } from '../../src/database/repositories/permission.repository.js';
import type {
  RefreshTokenCreate,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../../src/database/repositories/refresh-token.repository.js';
import type { Role, RoleRepository } from '../../src/database/repositories/role.repository.js';
import type { User, UserRepository } from '../../src/database/repositories/user.repository.js';

/**
 * In-memory stand-ins for the four frozen repository contracts (CONTRACTS.md §5), used by the
 * e2e suite so the **real** `AppModule` — guards, strategies, controllers, DTO validation,
 * interceptors, exception filter — can be exercised end to end without a live Postgres or
 * Redis. Only the persistence boundary is substituted; nothing above it is mocked, which is
 * what makes the suite meaningful for the "strategies are interchangeable" claim (plan.md §11
 * Phase 13).
 *
 * They are deliberately simple and per-test: no persistence, no cross-test leakage.
 */

export interface InMemoryStore {
  users: User[];
  roles: Role[];
  permissions: Permission[];
  /** roleId → granted permission ids */
  grants: Map<string, Set<string>>;
  /** userId → assigned role ids */
  assignments: Map<string, Set<string>>;
  refreshTokens: RefreshTokenRecord[];
}

export function createInMemoryStore(): InMemoryStore {
  return {
    users: [],
    roles: [],
    permissions: [],
    grants: new Map(),
    assignments: new Map(),
    refreshTokens: [],
  };
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/**
 * The seeded baseline (plan.md §5) reduced to what the e2e assertions need: a `user` role that
 * every self-registered account receives, granting `read:Post` — but deliberately NOT
 * `update:Post`, so a denial can be asserted as well as an allow.
 */
export function seedBaselineRbac(store: InMemoryStore): void {
  const userRole: Role = { id: 'role-user', name: 'user', description: null, isSystem: true };
  const adminRole: Role = { id: 'role-admin', name: 'admin', description: null, isSystem: true };
  const readPost: Permission = {
    id: 'perm-read-post',
    action: 'read',
    subject: 'Post',
    name: 'read:Post',
    description: null,
    isSystem: true,
  };
  const manageAll: Permission = {
    id: 'perm-manage-all',
    action: 'manage',
    subject: 'all',
    name: 'manage:all',
    description: null,
    isSystem: true,
  };

  store.roles.push(userRole, adminRole);
  store.permissions.push(readPost, manageAll);
  store.grants.set(userRole.id, new Set([readPost.id]));
  store.grants.set(adminRole.id, new Set([manageAll.id]));
}

export function createInMemoryUserRepository(store: InMemoryStore): UserRepository {
  return {
    async findById(id: string): Promise<User | null> {
      return store.users.find((user) => user.id === id && user.deletedAt === null) ?? null;
    },

    async findByEmail(email: string): Promise<User | null> {
      return store.users.find((user) => user.email === email && user.deletedAt === null) ?? null;
    },

    async create(data: { email: string; passwordHash: string }): Promise<User> {
      const now = new Date();
      const user: User = {
        id: nextId('user'),
        email: data.email,
        passwordHash: data.passwordHash,
        isActive: true,
        isEmailVerified: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      store.users.push(user);
      return user;
    },

    async updatePassword(id: string, passwordHash: string): Promise<void> {
      const user = store.users.find((candidate) => candidate.id === id);
      if (user) user.passwordHash = passwordHash;
    },

    async assignRole(userId: string, roleId: string): Promise<void> {
      const assigned = store.assignments.get(userId) ?? new Set<string>();
      assigned.add(roleId);
      store.assignments.set(userId, assigned);
    },

    async findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }> {
      const roleIds = [...(store.assignments.get(id) ?? new Set<string>())];
      const roles = roleIds
        .map((roleId) => store.roles.find((role) => role.id === roleId)?.name)
        .filter((name): name is string => name !== undefined);

      const permissionNames = roleIds.flatMap((roleId) =>
        [...(store.grants.get(roleId) ?? new Set<string>())].map(
          (permissionId) => store.permissions.find((permission) => permission.id === permissionId)?.name,
        ),
      );

      return { roles, permissions: [...new Set(permissionNames.filter((name): name is string => !!name))] };
    },

    async findUserIdsByRole(roleId: string): Promise<string[]> {
      return [...store.assignments.entries()]
        .filter(([, roleIds]) => roleIds.has(roleId))
        .map(([userId]) => userId);
    },
  };
}

export function createInMemoryRoleRepository(store: InMemoryStore): RoleRepository {
  return {
    async findById(id: string): Promise<Role | null> {
      return store.roles.find((role) => role.id === id) ?? null;
    },

    async findByName(name: string): Promise<Role | null> {
      return store.roles.find((role) => role.name === name) ?? null;
    },

    async findAll(): Promise<Role[]> {
      return [...store.roles];
    },

    async create(data: { name: string; description?: string; isSystem?: boolean }): Promise<Role> {
      const role: Role = {
        id: nextId('role'),
        name: data.name,
        description: data.description ?? null,
        isSystem: data.isSystem ?? false,
      };
      store.roles.push(role);
      return role;
    },

    async attachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
      const granted = store.grants.get(roleId) ?? new Set<string>();
      for (const permissionId of permissionIds) granted.add(permissionId);
      store.grants.set(roleId, granted);
    },

    async detachPermissions(roleId: string, permissionIds: string[]): Promise<void> {
      const granted = store.grants.get(roleId);
      if (!granted) return;
      for (const permissionId of permissionIds) granted.delete(permissionId);
    },

    async listPermissions(roleId: string): Promise<Permission[]> {
      const granted = store.grants.get(roleId) ?? new Set<string>();
      return store.permissions.filter((permission) => granted.has(permission.id));
    },

    async delete(id: string): Promise<void> {
      store.roles = store.roles.filter((role) => role.id !== id);
      store.grants.delete(id);
    },
  };
}

export function createInMemoryPermissionRepository(store: InMemoryStore): PermissionRepository {
  return {
    async findById(id: string): Promise<Permission | null> {
      return store.permissions.find((permission) => permission.id === id) ?? null;
    },

    async findByName(name: string): Promise<Permission | null> {
      return store.permissions.find((permission) => permission.name === name) ?? null;
    },

    async findAll(): Promise<Permission[]> {
      return [...store.permissions];
    },

    async create(data: {
      action: string;
      subject: string;
      description?: string;
      isSystem?: boolean;
    }): Promise<Permission> {
      const permission: Permission = {
        id: nextId('perm'),
        action: data.action,
        subject: data.subject,
        name: `${data.action}:${data.subject}`,
        description: data.description ?? null,
        isSystem: data.isSystem ?? false,
      };
      store.permissions.push(permission);
      return permission;
    },

    async delete(id: string): Promise<void> {
      store.permissions = store.permissions.filter((permission) => permission.id !== id);
    },
  };
}

/**
 * The refresh-token store implements the same "only a SHA-256 hash is ever at rest" rule the
 * real adapters must (CONTRACTS.md §9), so a leaked store still yields no usable token — and
 * rotation/reuse behaviour under `jwt-stateless` is exercised for real.
 */
export function createInMemoryRefreshTokenRepository(store: InMemoryStore): RefreshTokenRepository {
  return {
    async create(data: RefreshTokenCreate): Promise<void> {
      store.refreshTokens.push({
        id: nextId('refresh'),
        userId: data.userId,
        tokenHash: data.tokenHash,
        familyId: data.familyId,
        userAgent: data.userAgent,
        ip: data.ip,
        expiresAt: data.expiresAt,
        revokedAt: null,
        createdAt: new Date(),
      });
    },

    async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
      return store.refreshTokens.find((record) => record.tokenHash === tokenHash) ?? null;
    },

    async markRevoked(id: string): Promise<void> {
      const record = store.refreshTokens.find((candidate) => candidate.id === id);
      if (record) record.revokedAt = new Date();
    },

    async revokeFamily(familyId: string): Promise<void> {
      for (const record of store.refreshTokens) {
        if (record.familyId === familyId) record.revokedAt = new Date();
      }
    },

    async revokeAllForUser(userId: string): Promise<void> {
      for (const record of store.refreshTokens) {
        if (record.userId === userId) record.revokedAt = new Date();
      }
    },
  };
}
