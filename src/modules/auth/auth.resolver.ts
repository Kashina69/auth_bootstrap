import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import type { RequestMeta } from '../../auth-strategies/auth-strategy.interface.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RbacGuard } from '../../common/guards/rbac.guard.js';
import { AuthResultType } from '../../graphql/types/auth-result.type.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { AuthService } from './auth.service.js';
import { LoginDto, RefreshDto, RegisterDto } from './dto/index.js';

/** The GraphQL context `@nestjs/graphql` builds — the same platform request the guards read. */
interface GqlContext {
  req: FastifyRequest;
}

/**
 * The ceilings `auth.controller.ts` applies to the credential-guessing operations, repeated
 * here so the GraphQL twin of each route is throttled identically once the hardening wave
 * registers `ThrottlerGuard` globally. Kept next to the operations that use them rather than
 * imported, because the controller's copies are module-private and neither file may gain an
 * export without editing the other.
 */
const REGISTER_RATE_LIMIT = { default: { limit: 3, ttl: 60_000 } };
const LOGIN_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };
const REFRESH_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/**
 * The GraphQL half of the auth surface (plan.md §10). Each mutation is the same three steps
 * the controller performs — read the input, build `RequestMeta`, hand off to `AuthService` —
 * and shares the guards, the `@Public()` markers and the service methods with it, so neither
 * transport can drift from the other or from the active strategy.
 */
@Resolver()
export class AuthResolver {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(REGISTER_RATE_LIMIT)
  @Mutation(() => AuthResultType)
  register(@Args('input') dto: RegisterDto, @Context() context: GqlContext): Promise<AuthResultType> {
    return this.auth.register(dto, requestMeta(context.req));
  }

  @Public()
  @Throttle(LOGIN_RATE_LIMIT)
  @Mutation(() => AuthResultType)
  login(@Args('input') dto: LoginDto, @Context() context: GqlContext): Promise<AuthResultType> {
    return this.auth.login(dto, requestMeta(context.req));
  }

  @Public()
  @Throttle(REFRESH_RATE_LIMIT)
  @Mutation(() => AuthResultType)
  refresh(@Args('input') dto: RefreshDto, @Context() context: GqlContext): Promise<AuthResultType> {
    return this.auth.refresh(dto, requestMeta(context.req));
  }

  /**
   * The one guarded mutation, matching the controller's guarded route: `AuthGuard` runs first
   * so `RbacGuard` and `@CurrentUser()` see `req.user`. The request is the session reference —
   * only the active strategy knows where its session lives.
   */
  @UseGuards(AuthGuard, RbacGuard)
  @Mutation(() => Boolean)
  async logout(@CurrentUser() user: AuthenticatedUser, @Context() context: GqlContext): Promise<boolean> {
    await this.auth.logout(user, context.req);
    return true;
  }
}

function requestMeta(request: FastifyRequest): RequestMeta {
  return { userAgent: request.headers['user-agent'] ?? '', ip: request.ip };
}
