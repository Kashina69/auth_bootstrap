import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config.service.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  createSessionCookieOptions,
  readSessionId,
} from './session-cookie.js';
import { SESSION_TTL_SECONDS } from './session-store.js';

function requestWithCookie(cookie: string | undefined): FastifyRequest {
  return { headers: cookie === undefined ? {} : { cookie } } as unknown as FastifyRequest;
}

function config(nodeEnv: string): AppConfig {
  return { NODE_ENV: nodeEnv } as unknown as AppConfig;
}

describe('readSessionId', () => {
  it('reads the session id off the Cookie header', () => {
    expect(readSessionId(requestWithCookie(`${SESSION_COOKIE_NAME}=abc123`))).toBe('abc123');
  });

  it('returns null when there is no Cookie header at all', () => {
    expect(readSessionId(requestWithCookie(undefined))).toBeNull();
  });

  it('returns null when the header carries other cookies but not the session one', () => {
    expect(readSessionId(requestWithCookie('theme=dark; lang=en'))).toBeNull();
  });

  it('does not accept a differently-named cookie that merely contains the session name', () => {
    // The exact-name comparison is what keeps an attacker's `sessionid=` / `sid_extra=`
    // from being read as the credential.
    expect(readSessionId(requestWithCookie(`sessionid=attacker`))).toBeNull();
    expect(readSessionId(requestWithCookie(`${SESSION_COOKIE_NAME}_extra=attacker`))).toBeNull();
    expect(readSessionId(requestWithCookie(`xsid=attacker`))).toBeNull();
  });

  it('picks the session cookie out of a longer header', () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=the-real-one; lang=en`;
    expect(readSessionId(requestWithCookie(header))).toBe('the-real-one');
  });

  it('survives the whitespace a browser may leave around the pair', () => {
    expect(readSessionId(requestWithCookie(`${SESSION_COOKIE_NAME} = abc123`))).toBe('abc123');
  });

  it('skips a pair with no "=" instead of treating the whole pair as a value', () => {
    expect(readSessionId(requestWithCookie(`${SESSION_COOKIE_NAME}`))).toBeNull();
  });

  it('percent-decodes the value', () => {
    expect(readSessionId(requestWithCookie(`${SESSION_COOKIE_NAME}=a%3Db%2Fc`))).toBe('a=b/c');
  });

  it('yields a falsy id for an empty value, so the guard fails closed rather than looking it up', () => {
    expect(readSessionId(requestWithCookie(`${SESSION_COOKIE_NAME}=`))).toBeFalsy();
  });
});

/**
 * The "an empty cookie must not authenticate" invariant is NOT tested here. This file only
 * owns `readSessionId`, and every composition of it with `readSession` written at this level
 * either re-implements the strategy's `if (!sessionId) return null` gate (and so cannot fail
 * when that gate is removed) or hands `readSession` a stub that answers `null` for any input
 * (and so cannot fail at all). The real path is `validateRequest`, and the test lives there —
 * `session-redis.auth-strategy.spec.ts`, "planted under the empty-id hash".
 */
describe('createSessionCookieOptions', () => {
  it('pins the flags the client contract depends on', () => {
    expect(createSessionCookieOptions(config('test'), SESSION_TTL_SECONDS)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: SESSION_COOKIE_PATH,
      maxAge: SESSION_TTL_SECONDS,
    });
  });

  it('sets Secure only in production', () => {
    expect(createSessionCookieOptions(config('production'), SESSION_TTL_SECONDS).secure).toBe(true);
    expect(createSessionCookieOptions(config('development'), SESSION_TTL_SECONDS).secure).toBe(false);
  });

  it('scopes the cookie to the whole API surface, not one route', () => {
    // `AuthGuard` reads this cookie on every authenticated request; narrowing the path
    // would silently log out every non-refresh route.
    expect(SESSION_COOKIE_PATH).toBe('/');
  });

  it('passes the caller-supplied maxAge through unchanged', () => {
    expect(createSessionCookieOptions(config('test'), 1234).maxAge).toBe(1234);
  });
});
