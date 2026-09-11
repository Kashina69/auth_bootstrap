import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable, map } from 'rxjs';

export interface ApiResponse<T> {
  data: T;
  meta: { timestamp: string; path: string };
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T> | T> {
    // GraphQL already owns a `{ data, errors }` envelope — wrapping it would break the spec.
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    return next.handle().pipe(map((data) => wrapInEnvelope(data, request.url)));
  }
}

function wrapInEnvelope<T>(data: T, path: string): ApiResponse<T> {
  return { data, meta: { timestamp: new Date().toISOString(), path } };
}
