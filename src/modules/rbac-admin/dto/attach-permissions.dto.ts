import { Field, InputType } from '@nestjs/graphql';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/**
 * Permissions are addressed by their `"action:subject"` name (plan.md §4) rather than by id,
 * because that is the string an operator already reads in a JWT and writes in `@Permissions()`.
 * Additive: attaching never removes the grants a role already holds.
 */
@InputType()
export class AttachPermissionsDto {
  @Field(() => [String])
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissions: string[];
}
