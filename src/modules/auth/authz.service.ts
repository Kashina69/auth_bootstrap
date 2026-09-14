import { Inject, Injectable } from '@nestjs/common';
import { AUTHZ_PROVIDER_TOKEN } from '../../common/constants.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { can } from '../../rbac-core/index.js';
import type { IAuthorizationProvider } from '../../rbac-strategies/authorization-provider.interface.js';

/** The `/authz/check` answer. An object rather than a bare boolean so both transports — and
 *  any future field such as the matched grant — expose the same shape (plan.md §10). */
export interface PermissionCheckResult {
  allowed: boolean;
}

/**
 * The read-only identity/authz surface (plan.md §11 Phase 12).
 *
 * Both methods deliberately resolve through `IAuthorizationProvider.getContext()` rather than
 * reading `user.roles` / `user.permissions`: those arrays are populated only by
 * embedded-claims, so a client asking "may I?" under db-live would otherwise be told "no" for
 * every permission it actually holds. Going through the provider means the answer is the same
 * one `RbacGuard` would reach for the same request, under either strategy.
 */
@Injectable()
export class AuthzService {
  constructor(@Inject(AUTHZ_PROVIDER_TOKEN) private readonly authz: IAuthorizationProvider) {}

  /** The caller's own identity, with roles/permissions filled in for both RBAC strategies. */
  async describeIdentity(user: AuthenticatedUser): Promise<AuthenticatedUser> {
    const context = await this.authz.getContext(user);
    return { ...user, roles: context.roles, permissions: context.permissions };
  }

  async checkPermission(
    user: AuthenticatedUser,
    action: string,
    subject: string,
  ): Promise<PermissionCheckResult> {
    const context = await this.authz.getContext(user);
    return { allowed: can(context, action, subject) };
  }
}
