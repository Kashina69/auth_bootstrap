import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable, tap } from 'rxjs';

/** implementation.spec.md §1: never log a plaintext password, even at debug level. */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set(['password', 'newPassword', 'confirmPassword']);
const REDACTED = '[REDACTED]';

export function redactSensitiveFields(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, SENSITIVE_FIELDS.has(key) ? REDACTED : value]),
  );
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const startedAt = Date.now();
    this.logger.log(`--> ${request.method} ${request.url} body=${stringifyRedacted(request.body)}`);
    return next.handle().pipe(
      tap({
        next: () => this.logger.log(`<-- ${request.method} ${request.url} ${statusOf(context)} ${elapsed(startedAt)}ms`),
        error: (error: unknown) =>
          this.logger.error(`<-- ${request.method} ${request.url} ${describeError(error)} ${elapsed(startedAt)}ms`),
      }),
    );
  }
}

function stringifyRedacted(body: unknown): string {
  if (body === undefined || body === null) return '-';
  return JSON.stringify(redactSensitiveFields(body));
}

function statusOf(context: ExecutionContext): number {
  return context.switchToHttp().getResponse<{ statusCode: number }>().statusCode;
}

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
