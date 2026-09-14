import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { AuthenticatedUser } from '../../rbac-core/index.js';

/**
 * Injects the `AuthenticatedUser` that `AuthGuard` attached to the request. It branches
 * the same way the guards do, so it resolves on HTTP controllers and GraphQL resolvers alike.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined => getRequest(context).user,
);

function getRequest(context: ExecutionContext) {
  if (context.getType<'graphql'>() === 'graphql') {
    return GqlExecutionContext.create(context).getContext().req;
  }
  return context.switchToHttp().getRequest();
}
