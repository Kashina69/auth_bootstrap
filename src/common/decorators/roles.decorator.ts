import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../constants.js';

/**
 * Records the role names a route is meant for.
 *
 * No guard in this module reads `ROLES_KEY` — authorization decisions run through
 * `@Permissions()` / `RbacGuard`, which is the deny-by-default path. Kept because the
 * public API listed in the plan exposes it; a role-based guard would need its own wave.
 */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
