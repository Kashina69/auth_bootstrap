import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../constants.js';

/**
 * Opts a controller or handler out of authentication. `AuthGuard` checks this before
 * calling the auth strategy, so the route is reachable with no verified identity.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
