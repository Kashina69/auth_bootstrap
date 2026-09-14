import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { AuthResult, IAuthStrategy } from '../../auth-strategies/auth-strategy.interface.js';
import type { AppConfig } from '../../config/app-config.service.js';
import { LoginAttemptService } from '../../common/security/login-attempt.service.js';
import { PasswordService } from '../../common/security/password.service.js';
import type { Role, RoleRepository } from '../../database/repositories/role.repository.js';
import type { User, UserRepository } from '../../database/repositories/user.repository.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import { AuthService } from './auth.service.js';

const META = { userAgent: 'vitest', ip: '127.0.0.1' };
const PASSWORD = 'Correct horse battery 1!';
const EMAIL = 'new.user@example.com';
const DEFAULT_ROLE: Role = { id: 'role-user', name: 'user', description: null, isSystem: true };

/** In-memory stand-in for the ORM adapter; keys on the exact string so casing bugs show up. */
function createFakeUsers() {
  const byEmail = new Map<string, User>();
  const roleAssignments: Array<{ userId: string; roleId: string }> = [];

  const repository: UserRepository = {
    findById: (id) => Promise.resolve([...byEmail.values()].find((u) => u.id === id) ?? null),
    findByEmail: (email) => Promise.resolve(byEmail.get(email) ?? null),
    create(data) {
      const user: User = {
        id: `user-${byEmail.size + 1}`,
        email: data.email,
        passwordHash: data.passwordHash,
        isActive: true,
        isEmailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      byEmail.set(data.email, user);
      return Promise.resolve(user);
    },
    updatePassword: () => Promise.resolve(),
    assignRole(userId, roleId) {
      roleAssignments.push({ userId, roleId });
      return Promise.resolve();
    },
    findRolesAndPermissions: () => Promise.resolve({ roles: ['user'], permissions: ['read:Post'] }),
    findUserIdsByRole: () => Promise.resolve([]),
  };

  return { byEmail, roleAssignments, repository };
}

const roles: RoleRepository = {
  findById: () => Promise.resolve(DEFAULT_ROLE),
  findByName: (name) => Promise.resolve(name === DEFAULT_ROLE.name ? DEFAULT_ROLE : null),
  findAll: () => Promise.resolve([DEFAULT_ROLE]),
  create: () => Promise.reject(new Error('not used')),
  attachPermissions: () => Promise.resolve(),
  detachPermissions: () => Promise.resolve(),
  listPermissions: () => Promise.resolve([]),
  delete: () => Promise.resolve(),
};

/** Records the user the service verified, the way a real strategy receives the session subject. */
function createFakeStrategy() {
  const seen: AuthenticatedUser[] = [];
  const strategy: IAuthStrategy = {
    login(user: AuthenticatedUser): Promise<AuthResult> {
      seen.push(user);
      return Promise.resolve({
        user,
        expiresAt: '2099-01-01T00:00:00.000Z',
        accessToken: 'access',
        refreshToken: 'refresh',
      });
    },
    refresh: () => Promise.reject(new Error('not used')),
    logout: () => Promise.resolve(),
    validateRequest: () => Promise.resolve(null),
  };
  return { seen, strategy };
}

/** Records the lockout calls in memory, so the wiring is asserted without Redis. */
class FakeLoginAttempts extends LoginAttemptService {
  locked = false;
  readonly failures: string[] = [];
  readonly cleared: string[] = [];

  constructor() {
    super({ REDIS_URL: undefined } as AppConfig);
  }

  override isLocked(): Promise<boolean> {
    return Promise.resolve(this.locked);
  }

  override recordFailure(email: string): Promise<number> {
    this.failures.push(email);
    return Promise.resolve(this.failures.length);
  }

  override clear(email: string): Promise<void> {
    this.cleared.push(email);
    return Promise.resolve();
  }
}

function createService() {
  const users = createFakeUsers();
  const { seen, strategy } = createFakeStrategy();
  const attempts = new FakeLoginAttempts();
  return {
    users,
    seen,
    attempts,
    service: new AuthService(users.repository, roles, strategy, new PasswordService(), attempts),
  };
}

async function captureFailure(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to be rejected');
}

describe('AuthService', () => {
  it('registers the email lowercased and trimmed, then assigns the default role', async () => {
    const { users, service } = createService();

    await service.register({ email: '  New.User@Example.COM  ', password: PASSWORD }, META);

    expect([...users.byEmail.keys()]).toEqual([EMAIL]);
    expect(users.roleAssignments).toEqual([{ userId: 'user-1', roleId: DEFAULT_ROLE.id }]);
  });

  it('rejects a re-registration of the same address in a different casing', async () => {
    const { service } = createService();
    await service.register({ email: EMAIL, password: PASSWORD }, META);

    await expect(
      service.register({ email: 'NEW.USER@example.com', password: PASSWORD }, META),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('logs in regardless of the casing the client sends', async () => {
    const { seen, service } = createService();
    await service.register({ email: EMAIL, password: PASSWORD }, META);

    await service.login({ email: 'New.User@EXAMPLE.com', password: PASSWORD }, META);

    expect(seen[0]).toMatchObject({ id: 'user-1', email: EMAIL, roles: ['user'] });
  });

  it('fails an unknown email and a wrong password with the identical error', async () => {
    const { service } = createService();
    await service.register({ email: EMAIL, password: PASSWORD }, META);

    const unknownEmail = await captureFailure(service.login({ email: 'nobody@example.com', password: PASSWORD }, META));
    const wrongPassword = await captureFailure(service.login({ email: EMAIL, password: 'Wrong 1!' }, META));

    expect(unknownEmail).toBeInstanceOf(UnauthorizedException);
    expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
    expect(unknownEmail.message).toBe('Invalid email or password');
    expect(wrongPassword.message).toBe(unknownEmail.message);
  });

  it('fails a disabled account with that same generic error', async () => {
    const { users, service } = createService();
    await service.register({ email: EMAIL, password: PASSWORD }, META);
    const stored = users.byEmail.get(EMAIL) as User;
    users.byEmail.set(EMAIL, { ...stored, isActive: false });

    await expect(service.login({ email: EMAIL, password: PASSWORD }, META)).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('fails a locked account even with the right password, on the same generic error', async () => {
    const { attempts, seen, service } = createService();
    await service.register({ email: EMAIL, password: PASSWORD }, META);
    attempts.locked = true;
    const sessionsBefore = seen.length;

    const failure = await captureFailure(service.login({ email: EMAIL, password: PASSWORD }, META));

    expect(failure).toBeInstanceOf(UnauthorizedException);
    expect(failure.message).toBe('Invalid email or password');
    expect(seen).toHaveLength(sessionsBefore);
  });

  it('records a failure for a genuinely wrong password only', async () => {
    const { attempts, service } = createService();
    await service.register({ email: EMAIL, password: PASSWORD }, META);

    await captureFailure(service.login({ email: 'New.User@EXAMPLE.com', password: 'Wrong 1!' }, META));
    await captureFailure(service.login({ email: 'nobody@example.com', password: PASSWORD }, META));

    expect(attempts.failures).toEqual([EMAIL]);
  });

  it('clears the counter on a successful login', async () => {
    const { attempts, service } = createService();
    await service.register({ email: EMAIL, password: PASSWORD }, META);

    await service.login({ email: EMAIL, password: PASSWORD }, META);

    expect(attempts.cleared).toEqual([EMAIL]);
  });
});
