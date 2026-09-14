import { Field, InputType } from '@nestjs/graphql';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * plan.md §11 Phase 12 (`/authz/check`). The two halves of a permission, kept separate rather
 * than as one `"action:subject"` string because the subject may itself contain a colon and
 * `can()` takes them as distinct arguments. One DTO serves both transports, as everywhere else.
 */
@InputType()
export class CheckPermissionDto {
  // No `:`, for the same reason `@Permissions()` splits on the first one only: an action
  // naming a subject would make the pair ambiguous.
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  action: string;

  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  subject: string;
}
