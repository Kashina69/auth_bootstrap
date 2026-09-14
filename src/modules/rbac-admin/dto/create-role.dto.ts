import { Field, InputType } from '@nestjs/graphql';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Role names are compared verbatim against `Role.name`, so keep them URL- and log-friendly. */
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/**
 * plan.md §10: one DTO serves both transports. `class-validator` validates the REST body,
 * `@InputType()`/`@Field()` describe the GraphQL input — no second shape to keep in sync.
 *
 * There is deliberately no `isSystem` field: it is a server-side baseline flag (plan.md §5.4),
 * never something a client may set (CONTRACTS.md §9).
 */
@InputType()
export class CreateRoleDto {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(ROLE_NAME, { message: 'name must start alphanumerically and use only : _ - separators' })
  name: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
