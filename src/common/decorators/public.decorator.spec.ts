import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY } from '../constants.js';
import { Public } from './public.decorator.js';

describe('@Public()', () => {
  it('marks a handler with the key AuthGuard reads', () => {
    const handler = (): void => undefined;

    Public()(handler);

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
  });

  it('marks a controller class as well as a handler', () => {
    class AuthController {
      register(): void {}
    }

    Public()(AuthController);

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AuthController)).toBe(true);
  });

  it('leaves an unmarked handler unmarked, so the guard keeps denying by default', () => {
    const handler = (): void => undefined;

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
  });

  it('does not leak the mark onto a sibling handler', () => {
    class AuthController {
      login(): void {}
      me(): void {}
    }

    Public()(AuthController.prototype, 'login', Object.getOwnPropertyDescriptor(AuthController.prototype, 'login')!);

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AuthController.prototype.login)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AuthController.prototype.me)).toBeUndefined();
  });
});
