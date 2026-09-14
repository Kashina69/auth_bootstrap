import { Field, ObjectType } from '@nestjs/graphql';

/**
 * GraphQL projection of `PermissionCheckResult` (`authz.service.ts`) — the same field the REST
 * body carries, so a client can move between transports without reshaping anything (plan.md §10).
 *
 * Like `rbac-admin.models.ts`, this exists because the interface itself is framework-free and
 * must not be decorated with `@ObjectType()`.
 */
@ObjectType()
export class PermissionCheckResultType {
  @Field()
  allowed: boolean;
}
