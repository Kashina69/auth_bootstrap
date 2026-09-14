import { Module } from '@nestjs/common';
import { RbacAdminController } from './rbac-admin.controller.js';
import { RbacAdminResolver } from './rbac-admin.resolver.js';
import { RbacAdminService } from './rbac-admin.service.js';

/**
 * The runtime RBAC surface. `DatabaseModule` / `AppConfigModule` / `RbacStrategiesModule` are
 * `@Global()` in the composition root, so the repository and authorization-provider tokens the
 * service injects resolve without being re-imported here — the same shape as `AuthModule`.
 *
 * The resolver is registered even while `src/graphql/` owns the GraphQL bootstrap: it is an
 * ordinary provider whose decorators are metadata until a `GraphQLModule` exists, and wiring
 * it here keeps the REST and GraphQL halves of this vertical in one place.
 */
@Module({
  controllers: [RbacAdminController],
  providers: [RbacAdminService, RbacAdminResolver],
})
export class RbacAdminModule {}
