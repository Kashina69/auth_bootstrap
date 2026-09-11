import type { AppConfig } from '../../config/app-config.service.js';
import type { AuthenticatedUser, AuthzContext } from '../../rbac-core/index.js';
import type { IAuthorizationProvider } from '../authorization-provider.interface.js';

/**
 * RBAC strategy A (default) — CONTRACTS.md §4, plan.md §3.3.
 *
 * The read side of the embedded-claims contract. The auth strategy bakes the user's
 * roles and resolved `action:subject` permissions into the token/session at login and
 * refresh; `AuthGuard` has already verified that payload before `RbacGuard` calls
 * `getContext()`, so this is a pure in-memory read — no DB, no cache.
 *
 * `invalidate()` is deliberately a no-op: the claims live in the caller's token/session,
 * not in a server-side store this process could reach, so a role change simply applies
 * on the caller's next login/refresh. See README.md in this folder for the full picture.
 */
export class EmbeddedClaimsAuthorizationProvider implements IAuthorizationProvider {
  constructor(private readonly config: AppConfig) {}

  async getContext(user: AuthenticatedUser): Promise<AuthzContext> {
    return readEmbeddedClaims(user);
  }

  async invalidate(_userId: string): Promise<void> {
    // Nothing to clear — embedded claims are not cached server-side (see class doc above).
  }
}

/**
 * Deny by default: a field that is missing or not an array of strings — a JWT minted
 * before claims were baked in, a session that never carried them, a hand-rolled
 * `request.user` — resolves to `[]`, which makes `rbac-core.can()` return `false` rather
 * than pass. Only the already-verified `user` object is read here; a client-supplied
 * `roles`/`permissions` body field never reaches this call.
 */
function normalizeClaimList(claims: unknown): string[] {
  if (!Array.isArray(claims)) return [];
  return claims.filter((claim): claim is string => typeof claim === 'string');
}

function readEmbeddedClaims(user: AuthenticatedUser): AuthzContext {
  return {
    roles: normalizeClaimList(user?.roles),
    permissions: normalizeClaimList(user?.permissions),
  };
}
