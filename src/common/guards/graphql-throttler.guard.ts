import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';

/** The GraphQL context `@nestjs/apollo` builds — the same request `AuthGuard` reads. */
interface GraphqlContext {
  req: Record<string, any>;
}

/**
 * A GraphQL context carries no reply, so the base guard's `X-RateLimit-*` writes have nothing to
 * write to. Only those advisory headers go unwritten; the limits themselves are unaffected.
 */
const headersHaveNoTarget: Record<string, any> = { header: () => undefined };

/**
 * `ThrottlerGuard` is HTTP-only: `getRequestResponse()` calls `switchToHttp()` unconditionally, and
 * on a GraphQL field that hands `getTracker()` the resolver's root value, so `req.ip` throws before
 * the resolver — and so before its `AuthGuard` — ever runs.
 *
 * Skipping GraphQL here would not be a fix: `login`, `register` and `refresh` are GraphQL mutations,
 * so an unthrottled GraphQL endpoint lets an attacker brute-force credentials past spec §6 entirely.
 * Reading the request from the GraphQL context instead throttles both transports on the same terms,
 * and the per-operation `@Throttle()` ceilings still apply because the handler is still the resolver.
 */
@Injectable()
export class GraphqlThrottlerGuard extends ThrottlerGuard {
  protected override getRequestResponse(
    context: ExecutionContext,
  ): { req: Record<string, any>; res: Record<string, any> } {
    if (context.getType<'graphql'>() !== 'graphql') {
      return super.getRequestResponse(context);
    }

    const { req } = GqlExecutionContext.create(context).getContext<GraphqlContext>();
    return { req, res: headersHaveNoTarget };
  }
}
