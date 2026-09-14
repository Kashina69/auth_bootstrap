import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * GraphQL views of the persisted shapes in CONTRACTS.md §5. They exist because the domain
 * interfaces in `database/repositories/` are deliberately framework-free — decorating them
 * with `@ObjectType()` would tie the ORM contracts to `@nestjs/graphql`. REST serializes the
 * interfaces directly; GraphQL returns these structural mirrors, so both transports expose
 * exactly the same fields (plan.md §10).
 */
@ObjectType()
export class RbacRole {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field()
  isSystem: boolean;
}

@ObjectType()
export class RbacPermission {
  @Field(() => ID)
  id: string;

  @Field()
  action: string;

  @Field()
  subject: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;
}
