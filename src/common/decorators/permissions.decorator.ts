import { SetMetadata } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../constants.js';

interface RequiredPermission {
  action: string;
  subject: string;
}

/**
 * Declares the permissions a route requires, written as `"action:subject"` strings
 * (e.g. `@Permissions('update:Post')`). `RbacGuard` reads the metadata and denies by
 * default, so a decorated route is unreachable unless the identity resolved by
 * `AuthGuard` satisfies every entry.
 *
 * Subjects are case-sensitive: `can()` matches them verbatim against the
 * `"action:subject"` strings in an `AuthzContext`, so `'update:Post'` and `'update:post'`
 * are different requirements.
 *
 * Only the first `:` splits the string, so a subject may itself contain colons:
 * `'update:Sub:Thing'` → action `update`, subject `Sub:Thing`.
 */
export const Permissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions.map(toRequiredPermission));

function toRequiredPermission(permission: string): RequiredPermission {
  const separator = permission.indexOf(':');
  if (separator === -1) {
    throw new Error(`@Permissions() expects "action:subject", received "${permission}"`);
  }
  return { action: permission.slice(0, separator), subject: permission.slice(separator + 1) };
}
