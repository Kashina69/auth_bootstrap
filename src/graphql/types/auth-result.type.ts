import { Field, ObjectType } from '@nestjs/graphql';

/**
 * GraphQL projection of `AuthenticatedUser` (CONTRACTS.md §2) — the same fields the REST
 * body carries, so a client can move between transports without reshaping anything. The
 * identity itself is always built server-side; nothing here is client-supplied.
 */
@ObjectType()
export class AuthenticatedUserType {
  @Field()
  id: string;

  @Field()
  email: string;

  @Field()
  isActive: boolean;

  @Field()
  isEmailVerified: boolean;

  // Present only under the embedded-claims RBAC strategy (CONTRACTS.md §2) — left null by
  // db-live, whose roles/permissions live in the DB rather than in the session.
  @Field(() => [String], { nullable: true })
  roles?: string[];

  @Field(() => [String], { nullable: true })
  permissions?: string[];
}

/**
 * GraphQL projection of `AuthResult` (CONTRACTS.md §3). The tokens are null under
 * `session-redis`, which delivers its credential as a cookie instead; the resolver returns
 * whatever the active strategy produced and never inspects which one it was.
 */
@ObjectType()
export class AuthResultType {
  @Field(() => AuthenticatedUserType)
  user: AuthenticatedUserType;

  @Field()
  expiresAt: string;

  @Field({ nullable: true })
  accessToken?: string;

  @Field({ nullable: true })
  refreshToken?: string;
}
