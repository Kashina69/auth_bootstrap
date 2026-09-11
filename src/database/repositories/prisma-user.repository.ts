import type { Prisma, PrismaClient, User as UserRow } from '@prisma/client';
import type { User, UserRepository } from './user.repository.js';

type AssignmentRow = Prisma.UserRoleGetPayload<{
  include: { role: { include: { permissions: { include: { permission: true } } } } };
}>;

/**
 * Prisma implementation of `UserRepository`. Bound to the `USER_REPOSITORY` token by
 * `DatabaseModule.register()` when `DB_PROVIDER=prisma`.
 *
 * Soft-deleted users are invisible to both finders: `deleted_at` is the account
 * deactivation flag (plan.md §4), so a deleted user must not authenticate.
 */
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    return row === null ? null : toUser(row);
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.prisma.user.findFirst({ where: { email, deletedAt: null } });
    return row === null ? null : toUser(row);
  }

  async create(data: { email: string; passwordHash: string }): Promise<User> {
    const row = await this.prisma.user.create({
      data: { email: data.email, passwordHash: data.passwordHash },
    });
    return toUser(row);
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.updateMany({ where: { id }, data: { passwordHash } });
  }

  async assignRole(userId: string, roleId: string): Promise<void> {
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      update: {},
      create: { userId, roleId },
    });
  }

  /**
   * One round trip for roles *and* permissions: the join rows come back with the role and
   * its permission grants nested, so there is no per-role follow-up query (N+1).
   */
  async findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }> {
    const assignments = await this.prisma.userRole.findMany({
      where: { userId: id },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    return toAuthzContext(assignments);
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    isActive: row.isActive,
    isEmailVerified: row.isEmailVerified,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * A permission granted by two different roles must appear once — `rbac-core.can()` treats
 * the list as a set, and duplicated strings would inflate the JWT payload.
 */
function toAuthzContext(assignments: AssignmentRow[]): { roles: string[]; permissions: string[] } {
  return {
    roles: unique(assignments.map((assignment) => assignment.role.name)),
    permissions: unique(
      assignments.flatMap((assignment) =>
        assignment.role.permissions.map((grant) => grant.permission.name),
      ),
    ),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
