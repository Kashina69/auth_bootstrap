/**
 * THE CONTRACT for user persistence — CONTRACTS.md §5, verbatim.
 *
 * Nothing outside `database/` may import a concrete implementation: `AuthService` and
 * every strategy depend on this interface through the `USER_REPOSITORY` token, which is
 * what makes the ORM swap a one-line provider change.
 */

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(data: { email: string; passwordHash: string }): Promise<User>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  assignRole(userId: string, roleId: string): Promise<void>; // idempotent (no-op if already assigned)
  findRolesAndPermissions(id: string): Promise<{ roles: string[]; permissions: string[] }>;
}
