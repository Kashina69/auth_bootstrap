import type { Redis } from 'ioredis';
import type { AuthzContext } from '../../rbac-core/index.js';

/**
 * Short-TTL cache for a user's resolved roles/permissions (plan.md §3.3, RBAC strategy B).
 *
 * The cache is a performance optimization, never the source of truth: it exists only to
 * keep `RbacGuard` from hitting the DB on every request, and its TTL is the upper bound on
 * how long a revoked role can outlive the mutation that removed it. `invalidate()` closes
 * that window to zero for the requests that follow an admin change.
 */
export const AUTHZ_CONTEXT_TTL_SECONDS = 5;

export const EMPTY_AUTHZ_CONTEXT: AuthzContext = { roles: [], permissions: [] };

export function authzContextCacheKey(userId: string): string {
  return `rbac:context:${userId}`;
}

export async function readCachedContext(redis: Redis, userId: string): Promise<AuthzContext | null> {
  try {
    return parseCachedContext(await redis.get(authzContextCacheKey(userId)));
  } catch {
    // An unreachable cache is not an authorization answer — fall through to the DB, which
    // is still the authority.
    return null;
  }
}

export async function writeCachedContext(
  redis: Redis,
  userId: string,
  context: AuthzContext,
): Promise<void> {
  try {
    await redis.set(
      authzContextCacheKey(userId),
      JSON.stringify(context),
      'EX',
      AUTHZ_CONTEXT_TTL_SECONDS,
    );
  } catch {
    // A failed cache write must not fail a request the DB already answered correctly; the
    // answer is returned uncached and the next request simply reads the DB again.
  }
}

export async function clearCachedContext(redis: Redis, userId: string): Promise<void> {
  try {
    await redis.del(authzContextCacheKey(userId));
  } catch {
    // Best effort — a failed delete leaves the entry to expire within AUTHZ_CONTEXT_TTL_SECONDS.
  }
}

/**
 * Narrows an untrusted value (a JSON cache entry, or a repository return value) to an
 * `AuthzContext`, or `null` when it is not shaped like one. Returning `null` instead of a
 * coerced empty context keeps "the DB said nothing" distinguishable from "the DB returned
 * something unusable" at the call site.
 */
export function toAuthzContext(value: unknown): AuthzContext | null {
  if (typeof value !== 'object' || value === null) return null;

  const { roles, permissions } = value as Partial<AuthzContext>;
  if (!isStringArray(roles) || !isStringArray(permissions)) return null;

  return { roles: [...roles], permissions: [...permissions] };
}

function parseCachedContext(raw: string | null): AuthzContext | null {
  if (raw === null) return null;

  try {
    return toAuthzContext(JSON.parse(raw) as unknown);
  } catch {
    // A truncated/corrupt entry is treated as a miss.
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
