/**
 * Frozen DI tokens and reflector metadata keys — CONTRACTS.md §1.
 * Every strategy/repository implementation is bound to these tokens, which is what
 * lets a concrete implementation be swapped by editing one provider.
 */
export const AUTH_STRATEGY_TOKEN = Symbol('AUTH_STRATEGY_TOKEN');
export const AUTHZ_PROVIDER_TOKEN = Symbol('AUTHZ_PROVIDER_TOKEN');
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');
export const PERMISSION_REPOSITORY = Symbol('PERMISSION_REPOSITORY');
export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');
export const DB_CLIENT = Symbol('DB_CLIENT');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

// Reflector metadata keys (decorators)
export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';
