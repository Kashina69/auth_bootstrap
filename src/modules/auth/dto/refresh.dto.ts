import { Field, InputType } from '@nestjs/graphql';
import { IsString, MinLength } from 'class-validator';

/**
 * CONTRACTS.md §6. Shape frozen; the controller and the GraphQL input both reuse it — the
 * `@Field` decorators below only describe the class to the schema (plan.md §10).
 */
@InputType()
export class RefreshDto {
  @Field()
  @IsString()
  @MinLength(1)
  refreshToken: string;
}
