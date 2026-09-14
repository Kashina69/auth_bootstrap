import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Require lower + upper + digit + symbol, on top of the 8-character floor (§1 rules). */
const PASSWORD_STRENGTH = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

/**
 * CONTRACTS.md §6. Shape frozen; the controller and the GraphQL input both reuse it — the
 * `@Field` decorators below only describe the class to the schema (plan.md §10).
 */
@InputType()
export class RegisterDto {
  @Field()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @Field()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_STRENGTH, {
    message: 'password must contain a lowercase letter, an uppercase letter, a digit and a symbol',
  })
  password: string;
}
