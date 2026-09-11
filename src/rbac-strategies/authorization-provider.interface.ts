import type { AuthenticatedUser, AuthzContext } from '../rbac-core/index.js';

export interface IAuthorizationProvider {
  getContext(user: AuthenticatedUser): Promise<AuthzContext>;
  invalidate(userId: string): Promise<void>; // no-op for embedded-claims, real for db-live
}
