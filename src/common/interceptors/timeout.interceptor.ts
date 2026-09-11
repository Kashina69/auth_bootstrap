import { CallHandler, ExecutionContext, Injectable, NestInterceptor, RequestTimeoutException } from '@nestjs/common';
import { Observable, TimeoutError, catchError, timeout } from 'rxjs';

const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(REQUEST_TIMEOUT_MS),
      catchError((error: unknown) => rethrowTimeout(error)),
    );
  }
}

function rethrowTimeout(error: unknown): never {
  if (error instanceof TimeoutError) throw new RequestTimeoutException('Request timed out');
  throw error;
}
