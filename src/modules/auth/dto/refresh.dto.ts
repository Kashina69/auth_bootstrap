import { IsString, MinLength } from 'class-validator';

/** CONTRACTS.md §6. Shape frozen; the controller and the GraphQL input both reuse it. */
export class RefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken: string;
}
