import { CanActivate, ExecutionContext, Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { AUTH_STRATEGY_TOKEN, IS_PUBLIC_KEY } from '../constants.js';
import type { IAuthStrategy } from '../../auth-strategies/auth-strategy.interface.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_STRATEGY_TOKEN) private readonly authStrategy: IAuthStrategy,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = this.getRequest(context);
    const user = await this.authStrategy.validateRequest(req);
    if (!user) throw new UnauthorizedException();
    req.user = user; // downstream RbacGuard and @CurrentUser() read this
    return true;
  }

  private getRequest(context: ExecutionContext) {
    if (context.getType<'graphql'>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext().req;
    }
    return context.switchToHttp().getRequest();
  }
}
