import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import type { AuthResult, RequestMeta } from '../../auth-strategies/auth-strategy.interface.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RbacGuard } from '../../common/guards/rbac.guard.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { AuthService } from './auth.service.js';
import { LoginDto, RefreshDto, RegisterDto } from './dto/index.js';

/**
 * implementation.spec.md §6 ceilings, per IP. Tighter than the global throttler (plan.md §8)
 * because these three routes are the credential-guessing surface; they take effect once the
 * hardening wave registers `ThrottlerGuard` globally.
 */
const LOGIN_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };
const REGISTER_RATE_LIMIT = { default: { limit: 3, ttl: 60_000 } };
const REFRESH_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/**
 * The REST half of the auth surface (plan.md §10). Every method is the same three steps —
 * read the input, build `RequestMeta`, hand off to `AuthService` — because the transport is
 * all this layer knows: which concrete strategy issued the session is never visible here.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(REGISTER_RATE_LIMIT)
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() request: FastifyRequest): Promise<AuthResult> {
    return this.auth.register(dto, requestMeta(request));
  }

  @Public()
  @Throttle(LOGIN_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto, @Req() request: FastifyRequest): Promise<AuthResult> {
    return this.auth.login(dto, requestMeta(request));
  }

  @Public()
  @Throttle(REFRESH_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Req() request: FastifyRequest): Promise<AuthResult> {
    return this.auth.refresh(dto, requestMeta(request));
  }

  /**
   * The one guarded route: `AuthGuard` must run first so `RbacGuard` sees `request.user`
   * (spec §5). The request itself is the session reference — only the active strategy knows
   * where its session lives (bearer header, cookie, Redis key), so it reads its own ref
   * rather than this layer naming a strategy-specific cookie.
   */
  @UseGuards(AuthGuard, RbacGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() request: FastifyRequest): Promise<void> {
    await this.auth.logout(user, request);
  }
}

function requestMeta(request: FastifyRequest): RequestMeta {
  return { userAgent: request.headers['user-agent'] ?? '', ip: request.ip };
}
