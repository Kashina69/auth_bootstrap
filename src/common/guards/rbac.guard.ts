import { CanActivate, ExecutionContext, Injectable, Inject, ForbiddenException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { can } from '../../rbac-core/index.js';
import { AUTHZ_PROVIDER_TOKEN, PERMISSIONS_KEY } from '../constants.js';
import type { IAuthorizationProvider } from '../../rbac-strategies/authorization-provider.interface.js';

interface RequiredPermission {
  action: string;
  subject: string;
}

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    @Inject(AUTHZ_PROVIDER_TOKEN) private readonly authz: IAuthorizationProvider,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true; // no @Permissions() decorator = no extra check

    const req = this.getRequest(context);
    if (!req.user) throw new ForbiddenException(); // AuthGuard should have run first — belt & suspenders

    const ctx = await this.authz.getContext(req.user);
    const allowed = required.every((p) => can(ctx, p.action, p.subject));
    if (!allowed) throw new ForbiddenException('Insufficient permissions');
    return true;
  }

  private getRequest(context: ExecutionContext) {
    if (context.getType<'graphql'>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext().req;
    }
    return context.switchToHttp().getRequest();
  }
}
