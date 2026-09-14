import { generateKeyPairSync } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config.service.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { TokenService } from './token.service.js';

const HS256_SECRET = 'test-only-ephemeral-secret-value-at-least-32-chars';
const OTHER_SECRET = 'a-different-secret-value-at-least-32-chars-long';
const ISSUER = 'auth-service';
const AUDIENCE = 'auth-clients';

const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  isActive: true,
  isEmailVerified: true,
  roles: ['admin'],
  permissions: ['manage:all'],
};

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    JWT_ALGORITHM: 'HS256',
    JWT_SECRET: HS256_SECRET,
    RBAC_STRATEGY: 'embedded-claims',
    ...overrides,
  } as unknown as AppConfig;
}

function createService(config = createConfig()): TokenService {
  return new TokenService(new JwtService({ secret: HS256_SECRET }), config);
}

describe('issueAccessToken', () => {
  it('mints a token whose reported expiry is read back off the token, not assumed', () => {
    const service = createService();

    const issued = service.issueAccessToken(USER);
    const claims = service.verifyAccessToken(issued.accessToken);

    expect(Date.parse(issued.expiresAt)).toBe(claims.exp! * 1000);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('carries the identity claims the guards read', () => {
    const service = createService();

    const claims = service.verifyAccessToken(service.issueAccessToken(USER).accessToken);

    expect(claims).toMatchObject({
      sub: USER.id,
      email: USER.email,
      isActive: true,
      isEmailVerified: true,
    });
  });

  it('refuses to report an expiry it cannot read off the token', () => {
    // A token that decodes without `exp` must fail loudly here rather than return
    // `undefined` as an expiry for the caller to ship to a client.
    const jwt = { sign: () => 'a-token-without-exp', decode: () => ({ sub: USER.id }) } as unknown as JwtService;

    expect(() => new TokenService(jwt, createConfig()).issueAccessToken(USER)).toThrow(/exp/);
  });
});

describe('verifyAccessToken', () => {
  it('rejects a token signed with a different secret', () => {
    const foreign = new JwtService({ secret: OTHER_SECRET }).sign(
      { sub: USER.id },
      { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE },
    );

    expect(() => createService().verifyAccessToken(foreign)).toThrow();
  });

  it('rejects a token signed with the same secret under a different HMAC algorithm', () => {
    // The pin that only `verifyOptions().algorithms` can carry: with a symmetric secret
    // jsonwebtoken will happily verify any HMAC variant unless the list is pinned.
    const foreign = new JwtService({ secret: HS256_SECRET }).sign(
      { sub: USER.id },
      { algorithm: 'HS384', issuer: ISSUER, audience: AUDIENCE },
    );

    expect(() => createService().verifyAccessToken(foreign)).toThrow();
  });

  it('rejects a correctly signed token minted for another issuer', () => {
    const foreign = new JwtService({ secret: HS256_SECRET }).sign(
      { sub: USER.id },
      { algorithm: 'HS256', issuer: 'someone-else', audience: AUDIENCE },
    );

    expect(() => createService().verifyAccessToken(foreign)).toThrow();
  });

  it('rejects a correctly signed token minted for another audience', () => {
    // Same signing key, same issuer — only the audience differs. Without the pin, a token
    // minted for another service would be accepted here.
    const foreign = new JwtService({ secret: HS256_SECRET }).sign(
      { sub: USER.id },
      { algorithm: 'HS256', issuer: ISSUER, audience: 'someone-else' },
    );

    expect(() => createService().verifyAccessToken(foreign)).toThrow();
  });

});

describe('verifyAccessToken under RS256', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const rsaConfig = createConfig({ JWT_ALGORITHM: 'RS256', JWT_PRIVATE_KEY: privateKey, JWT_PUBLIC_KEY: publicKey });

  function createRsaService(): TokenService {
    return new TokenService(new JwtService({ privateKey, publicKey }), rsaConfig);
  }

  it('round-trips a token signed with the configured key pair', () => {
    const service = createRsaService();

    expect(service.verifyAccessToken(service.issueAccessToken(USER).accessToken).sub).toBe(USER.id);
  });

  it('rejects an HS256 token forged with the public key as the HMAC secret', () => {
    // The classic algorithm-confusion attack: pinning `algorithms` to the configured one
    // is the only thing that stops the public key being read as a shared secret.
    const service = createRsaService();
    const forged = new JwtService({ secret: publicKey }).sign(
      { sub: USER.id },
      { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE },
    );

    expect(() => service.verifyAccessToken(forged)).toThrow();
  });
});

describe('RBAC claims in the access token', () => {
  it('bakes roles and permissions in only under embedded-claims', () => {
    const service = createService(createConfig({ RBAC_STRATEGY: 'embedded-claims' }));

    const claims = service.verifyAccessToken(service.issueAccessToken(USER).accessToken);

    expect(claims.roles).toEqual(['admin']);
    expect(claims.permissions).toEqual(['manage:all']);
  });

  it('leaves them out under db-live, so a stale snapshot can never be trusted', () => {
    const service = createService(createConfig({ RBAC_STRATEGY: 'db-live' }));

    const claims = service.verifyAccessToken(service.issueAccessToken(USER).accessToken);

    expect(claims.roles).toBeUndefined();
    expect(claims.permissions).toBeUndefined();
  });

  it('defaults a claim-less user to empty lists rather than dropping the fields', () => {
    const service = createService(createConfig({ RBAC_STRATEGY: 'embedded-claims' }));

    const claims = service.verifyAccessToken(
      service.issueAccessToken({ ...USER, roles: undefined, permissions: undefined }).accessToken,
    );

    expect(claims.roles).toEqual([]);
    expect(claims.permissions).toEqual([]);
  });
});
