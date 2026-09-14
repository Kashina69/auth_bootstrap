import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * CONTRACTS.md §6. Shape frozen; the controller and the GraphQL input both reuse it — the
 * `@Field` decorators below only describe the class to the schema (plan.md §10).
 */
@InputType()
export class LoginDto {
  @Field()
  @IsEmail()
  @MaxLength(254)
  email: string;

  // Deliberately only a length floor: rejecting a weak password here would turn "wrong
  // password" into a distinguishable validation error and leak the password policy of a
  // possibly-existing account. Strength is enforced on register/change only.
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}
