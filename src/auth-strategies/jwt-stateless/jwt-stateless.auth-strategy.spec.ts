import { generateKeyPairSync } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.service.js';
import type {
  RefreshTokenCreate,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../../database/repositories/refresh-token.repository.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { JwtStatelessAuthStrategy } from './jwt-stateless.auth-strategy.js';
import { RefreshTokenService } from './refresh-token.service.js';

const HS256_SECRET = 'test-only-ephemeral-secret-value-at-least-32-chars';
const META = { userAgent: 'vitest', ip: '127.0.0.1' };

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
    AUTH_STRATEGY: 'jwt-stateless',
    ...overrides,
  } as unknown as AppConfig;
}

/** In-memory stand-in for the ORM adapter; records calls so reuse handling is observable. */
function createFakeRepository() {
  const rows = new Map<string, RefreshTokenRecord>();
  const revokedFamilies: string[] = [];
  let sequence = 0;

  return {
    rows,
    revokedFamilies,
    create(data: RefreshTokenCreate): Promise<void> {
      const id = `row-${++sequence}`;
      rows.set(data.tokenHash, { id, revokedAt: null, createdAt: new Date(), ...data });
      return Promise.resolve();
    },
    findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
      return Promise.resolve(rows.get(tokenHash) ?? null);
    },
    markRevoked(id: string): Promise<void> {
      for (const [hash, row] of rows) if (row.id === id) rows.set(hash, { ...row, revokedAt: new Date() });
      return Promise.resolve();
    },
    revokeFamily(familyId: string): Promise<void> {
      revokedFamilies.push(familyId);
      for (const [hash, row] of rows) if (row.familyId === familyId) rows.set(hash, { ...row, revokedAt: new Date() });
      return Promise.resolve();
    },
    revokeAllForUser(userId: string): Promise<void> {
      for (const [hash, row] of rows) if (row.userId === userId) rows.set(hash, { ...row, revokedAt: new Date() });
      return Promise.resolve();
    },
  } satisfies RefreshTokenRepository & { rows: Map<string, RefreshTokenRecord>; revokedFamilies: string[] };
}

/** In-memory stand-in for the user repository; refresh re-resolves identity + claims from it. */
function createFakeUserRepository(): UserRepository {
  return {
    findById: () =>
      Promise.resolve({
        id: USER.id,
        email: USER.email,
        passwordHash: 'unused',
        isActive: true,
        isEmailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      }),
    findByEmail: () => Promise.resolve(null),
    create: () => Promise.resolve({} as never),
    updatePassword: () => Promise.resolve(),
    assignRole: () => Promise.resolve(),
    findRolesAndPermissions: () =>
      Promise.resolve({ roles: USER.roles ?? [], permissions: USER.permissions ?? [] }),
  };
}

describe('RefreshTokenService', () => {
  it('stores only the hash and rotates into the same family', async () => {
    const repo = createFakeRepository();
    const service = new RefreshTokenService(repo);

    const raw = await service.issue(USER.id, META);
    const [stored] = [...repo.rows.values()];
    expect(stored.tokenHash).not.toBe(raw);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const rotated = await service.rotate(raw, META);
    expect(rotated.userId).toBe(USER.id);
    expect(rotated.refreshToken).not.toBe(raw);
    expect([...repo.rows.values()].map((row) => row.familyId)).toEqual([stored.familyId, stored.familyId]);
  });

  it('revokes the whole family when a rotated token is replayed', async () => {
    const repo = createFakeRepository();
    const service = new RefreshTokenService(repo);
    const raw = await service.issue(USER.id, META);

    await service.rotate(raw, META);
    await expect(service.rotate(raw, META)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(repo.revokedFamilies).toEqual([[...repo.rows.values()][0].familyId]);
    expect([...repo.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('rejects unknown and expired tokens', async () => {
    const repo = createFakeRepository();
    const service = new RefreshTokenService(repo);
    await expect(service.rotate('not-a-token', META)).rejects.toBeInstanceOf(UnauthorizedException);

    const raw = await service.issue(USER.id, META);
    const [stored] = [...repo.rows.values()];
    repo.rows.set(stored.tokenHash, { ...stored, expiresAt: new Date(Date.now() - 1_000) });

    await expect(service.rotate(raw, META)).rejects.toThrow('expired');
    expect(repo.revokedFamilies).toEqual([]);
  });
});

describe('JwtStatelessAuthStrategy', () => {
  function createStrategy(config = createConfig()) {
    const repo = createFakeRepository();
    return {
      repo,
      strategy: new JwtStatelessAuthStrategy(
        repo,
        createFakeUserRepository(),
        new JwtService({ secret: HS256_SECRET }),
        config,
      ),
    };
  }

  it('round-trips the access token through login and validateRequest', async () => {
    const { strategy } = createStrategy();
    const result = await strategy.login(USER, META);

    expect(result.user).toEqual(USER);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());

    const request = { headers: { authorization: `Bearer ${result.accessToken}` } };
    expect(await strategy.validateRequest(request as never)).toEqual(USER);
  });

  it('returns null instead of throwing for a missing or foreign-signed token', async () => {
    const { strategy } = createStrategy();
    const forged = new JwtService({ secret: 'a-different-secret-value-at-least-32-chars' }).sign(
      { sub: USER.id },
      { algorithm: 'HS256', issuer: 'auth-service', audience: 'auth-clients' },
    );

    expect(await strategy.validateRequest({ headers: {} } as never)).toBeNull();
    expect(await strategy.validateRequest({ headers: { authorization: `Bearer ${forged}` } } as never)).toBeNull();
  });

  it('rotates on refresh and revokes every refresh token on logout', async () => {
    const { repo, strategy } = createStrategy();
    const loggedIn = await strategy.login(USER, META);

    const refreshed = await strategy.refresh(loggedIn.refreshToken, META);
    expect(refreshed.refreshToken).not.toBe(loggedIn.refreshToken);
    // replaying the rotated-away token is reuse, and kills the family
    await expect(strategy.refresh(loggedIn.refreshToken, META)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    await strategy.logout(USER.id, undefined);
    expect([...repo.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('omits RBAC claims from the token under db-live', async () => {
    const { strategy } = createStrategy(createConfig({ RBAC_STRATEGY: 'db-live' }));
    const result = await strategy.login(USER, META);
    const user = await strategy.validateRequest({
      headers: { authorization: `Bearer ${result.accessToken}` },
    } as never);

    expect(user).toMatchObject({ id: USER.id, email: USER.email });
    expect(user?.roles).toBeUndefined();
    expect(user?.permissions).toBeUndefined();
  });

  describe('RS256 (the default algorithm)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const rsaConfig = createConfig({ JWT_ALGORITHM: 'RS256', JWT_PRIVATE_KEY: privateKey, JWT_PUBLIC_KEY: publicKey });
    const jwt = new JwtService({ privateKey, publicKey });

    function validate(strategy: JwtStatelessAuthStrategy, token: string) {
      return strategy.validateRequest({ headers: { authorization: `Bearer ${token}` } } as never);
    }

    it('signs and verifies with the configured key pair', async () => {
      const strategy = new JwtStatelessAuthStrategy(createFakeRepository(), createFakeUserRepository(), jwt, rsaConfig);
      const result = await strategy.login(USER, META);
      expect(await validate(strategy, result.accessToken!)).toEqual(USER);
    });

    it('rejects an HS256 token signed with the public key as the HMAC secret', async () => {
      const strategy = new JwtStatelessAuthStrategy(createFakeRepository(), createFakeUserRepository(), jwt, rsaConfig);
      const confusion = new JwtService({ secret: publicKey }).sign(
        { sub: USER.id },
        { algorithm: 'HS256', issuer: 'auth-service', audience: 'auth-clients' },
      );

      expect(await validate(strategy, confusion)).toBeNull();
    });

    it('rejects a correctly signed token from another issuer or audience', async () => {
      const strategy = new JwtStatelessAuthStrategy(createFakeRepository(), createFakeUserRepository(), jwt, rsaConfig);
      const wrongAudience = jwt.sign(
        { sub: USER.id },
        { algorithm: 'RS256', issuer: 'auth-service', audience: 'someone-else' },
      );

      expect(await validate(strategy, wrongAudience)).toBeNull();
    });
  });
});
