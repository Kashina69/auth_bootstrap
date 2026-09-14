import { Field, ID, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * The user is named by the route/argument, so only the role travels in the body.
 * `UserRepository.assignRole` is idempotent, which makes re-assigning a no-op rather than
 * an error — registrations and scripted provisioning both rely on that.
 */
@InputType()
export class AssignRoleDto {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  roleId: string;
}
