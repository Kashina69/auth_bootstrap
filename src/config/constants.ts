/**
 * Non-secret defaults. These are deliberately NOT part of the zod env schema, which
 * mirrors implementation.spec.md §8 verbatim — secrets are the only thing that may
 * differ per deployment.
 */
export const DEFAULT_PORT = 3000;
export const DEFAULT_JWT_ACCESS_TOKEN_TTL = '15m';
export const DEFAULT_JWT_REFRESH_TOKEN_TTL = '30d';
export const DEFAULT_JWT_ISSUER = 'auth-service';
export const DEFAULT_JWT_AUDIENCE = 'auth-clients';
