import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { RequestTimeoutException } from '@nestjs/common';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeoutInterceptor } from './timeout.interceptor.js';

const NEVER = new Observable<never>(() => undefined);
const CONTEXT = {} as ExecutionContext;

const handler = (source: Observable<unknown>): CallHandler => ({ handle: () => source });

afterEach(() => {
  vi.useRealTimers();
});

describe('TimeoutInterceptor', () => {
  it('forwards a payload that arrives in time, unchanged', async () => {
    const interceptor = new TimeoutInterceptor();

    const result = await firstValueFrom(interceptor.intercept(CONTEXT, handler(of('payload'))));

    expect(result).toBe('payload');
  });

  it('turns a request that outlives the deadline into a 408, not a hang', async () => {
    vi.useFakeTimers();
    const interceptor = new TimeoutInterceptor();

    const settled = firstValueFrom(interceptor.intercept(CONTEXT, handler(NEVER))).catch(
      (error: unknown) => error,
    );

    // A minute of wall clock is not spent here — the deadline is what is under test.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await Promise.race([settled, Promise.resolve('still-pending')])).toBe('still-pending');

    await vi.advanceTimersByTimeAsync(1_001);
    expect(await settled).toBeInstanceOf(RequestTimeoutException);
  });

  it('rethrows an application error as-is instead of reporting a timeout', async () => {
    const interceptor = new TimeoutInterceptor();
    const original = new Error('repository exploded');

    const error = await firstValueFrom(
      interceptor.intercept(CONTEXT, handler(throwError(() => original))),
    ).catch((caught: unknown) => caught);

    expect(error).toBe(original);
  });

  it('does not report a request that failed fast as having timed out', async () => {
    const interceptor = new TimeoutInterceptor();

    const error = await firstValueFrom(
      interceptor.intercept(CONTEXT, handler(throwError(() => new Error('forbidden')))),
    ).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(RequestTimeoutException);
  });
});
