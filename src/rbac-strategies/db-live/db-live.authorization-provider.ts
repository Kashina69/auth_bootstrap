import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/app-config.service.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import type { AuthenticatedUser, AuthzContext } from '../../rbac-core/index.js';
import type { IAuthorizationProvider } from '../authorization-provider.interface.js';
import {
  clearCachedContext,
  EMPTY_AUTHZ_CONTEXT,
  readCachedContext,
  toAuthzContext,
  writeCachedContext,
} from './authz-context-cache.js';

/**
 * RBAC strategy B — live DB lookup with a short-TTL cache (CONTRACTS.md §4, plan.md §3.3).
 *
 * `RbacGuard` calls `getContext()` on every guarded request; the context is read from the
 * cache when warm and from `UserRepository.findRolesAndPermissions()` when not. Every
 * failure path returns the empty context — deny by default, never throw — because a guard
 * that cannot establish permissions must not grant them.
 *
 * `invalidate()` is the other half of the strategy: `rbac-admin` mutations (role/permission
 * changes) call it so the very next request re-reads the DB instead of waiting out the TTL.
 */
export class DbLiveAuthorizationProvider implements IAuthorizationProvider {
  constructor(
    private readonly users: UserRepository,
    private readonly redis: Redis,
    private readonly config: AppConfig,
  ) {}

  async getContext(user: AuthenticatedUser): Promise<AuthzContext> {
    return resolveAuthzContext(this.users, this.redis, user);
  }

  async invalidate(userId: string): Promise<void> {
    if (!isUsableUserId(userId)) return;
    await clearCachedContext(this.redis, userId);
  }
}

async function resolveAuthzContext(
  users: UserRepository,
  redis: Redis,
  user: AuthenticatedUser,
): Promise<AuthzContext> {
  const userId = user?.id;
  if (!isUsableUserId(userId)) return EMPTY_AUTHZ_CONTEXT;

  const cached = await readCachedContext(redis, userId);
  if (cached !== null) return cached;

  return loadAndCacheAuthzContext(users, redis, userId);
}

/**
 * A failed or unusable DB read is deliberately *not* cached: an empty context here means
 * "deny this request", and caching it would extend a transient outage into a TTL-long
 * lockout for a user whose permissions are still intact.
 */
async function loadAndCacheAuthzContext(
  users: UserRepository,
  redis: Redis,
  userId: string,
): Promise<AuthzContext> {
  const loaded = await loadAuthzContext(users, userId);
  if (loaded === null) return EMPTY_AUTHZ_CONTEXT;

  await writeCachedContext(redis, userId, loaded);
  return loaded;
}

async function loadAuthzContext(
  users: UserRepository,
  userId: string,
): Promise<AuthzContext | null> {
  try {
    return toAuthzContext(await users.findRolesAndPermissions(userId));
  } catch {
    return null;
  }
}

function isUsableUserId(userId: string | undefined | null): userId is string {
  return typeof userId === 'string' && userId.length > 0;
}
