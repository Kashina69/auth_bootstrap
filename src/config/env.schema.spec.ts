import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const RS256_BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/auth',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----',
};

describe('validateEnv', () => {
  it('applies the documented strategy defaults', () => {
    const env = validateEnv(RS256_BASE);

    expect(env.AUTH_STRATEGY).toBe('jwt-stateless');
    expect(env.RBAC_STRATEGY).toBe('embedded-claims');
    expect(env.DB_PROVIDER).toBe('prisma');
    expect(env.JWT_ALGORITHM).toBe('RS256');
  });

  it('accepts the mongoose provider value', () => {
    expect(validateEnv({ ...RS256_BASE, DB_PROVIDER: 'mongoose' }).DB_PROVIDER).toBe('mongoose');
  });

  it('refuses RS256 without both PEM keys', () => {
    const { JWT_PUBLIC_KEY: _omitted, ...withoutPublicKey } = RS256_BASE;

    expect(() => validateEnv(withoutPublicKey)).toThrow(/RS256 requires JWT_PRIVATE_KEY and JWT_PUBLIC_KEY/);
  });

  it('refuses HS256 without a secret', () => {
    expect(() => validateEnv({ ...RS256_BASE, JWT_ALGORITHM: 'HS256' })).toThrow(
      /HS256 requires JWT_SECRET/,
    );
  });

  it('accepts HS256 with a 32+ char secret and no PEM keys', () => {
    const env = validateEnv({
      NODE_ENV: 'test',
      DATABASE_URL: RS256_BASE.DATABASE_URL,
      JWT_ALGORITHM: 'HS256',
      JWT_SECRET: 'a'.repeat(32),
    });

    expect(env.JWT_ALGORITHM).toBe('HS256');
  });

  it('requires REDIS_URL for session-redis and db-live', () => {
    expect(() => validateEnv({ ...RS256_BASE, AUTH_STRATEGY: 'session-redis' })).toThrow(
      /REDIS_URL is required/,
    );
    expect(() => validateEnv({ ...RS256_BASE, RBAC_STRATEGY: 'db-live' })).toThrow(/REDIS_URL is required/);
  });

  it('fails fast when DATABASE_URL is missing or malformed', () => {
    expect(() => validateEnv({ ...RS256_BASE, DATABASE_URL: 'not-a-url' })).toThrow(
      /refusing to start/,
    );
  });

  it('defaults PORT to 3000 and coerces a string port from .env', () => {
    expect(validateEnv(RS256_BASE).PORT).toBe(3000);
    expect(validateEnv({ ...RS256_BASE, PORT: '8080' }).PORT).toBe(8080);
  });

  it('refuses an out-of-range or non-numeric PORT', () => {
    expect(() => validateEnv({ ...RS256_BASE, PORT: '99999' })).toThrow(/refusing to start/);
    expect(() => validateEnv({ ...RS256_BASE, PORT: 'not-a-port' })).toThrow(/refusing to start/);
  });
});
