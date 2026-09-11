import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/app-config.service.js';
import type { SessionCookieOptions } from './session.types.js';

export const SESSION_COOKIE_NAME = 'sid';

/**
 * The session cookie rides along on EVERY authenticated request — `AuthGuard` calls
 * `validateRequest` on all of them — so it is scoped to the whole API surface.
 *
 * This is deliberately not the `path=/auth/refresh` scope that implementation.spec.md §2
 * gives the `jwt-stateless` refresh cookie: that cookie is consumed by exactly one
 * endpoint, whereas the session cookie is the only credential this strategy has. Scoping
 * it to `/auth/refresh` would leave `validateRequest` with no cookie to read on every
 * other route and silently log every request out.
 */
export const SESSION_COOKIE_PATH = '/';

export function readSessionId(req: FastifyRequest): string | null {
  return readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
}

export function createSessionCookieOptions(
  config: AppConfig,
  maxAgeSeconds: number,
): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: SESSION_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

/**
 * `@fastify/cookie` is not a dependency of this template, and this folder must stay
 * deletable/self-contained, so the `Cookie` header is parsed directly.
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1 || pair.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(pair.slice(separator + 1).trim());
  }
  return null;
}
