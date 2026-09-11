/**
 * THE CONTRACT for permission persistence — CONTRACTS.md §5, verbatim.
 *
 * `Permission.name` is the `"{action}:{subject}"` string defined in plan.md §4. It is
 * what travels in the JWT/session payload and what `rbac-core.can()` matches against, so
 * it is persisted rather than re-derived at read time.
 */

export interface Permission {
  id: string;
  action: string;
  subject: string;
  name: string; // generated "{action}:{subject}"
  description: string | null;
}

export interface PermissionRepository {
  findById(id: string): Promise<Permission | null>;
  findByName(name: string): Promise<Permission | null>;
  findAll(): Promise<Permission[]>;
  create(data: { action: string; subject: string; description?: string }): Promise<Permission>;
  delete(id: string): Promise<void>;
}
