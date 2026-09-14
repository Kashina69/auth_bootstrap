import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthResult, IAuthStrategy, RequestMeta } from '../../auth-strategies/auth-strategy.interface.js';
import { AUTH_STRATEGY_TOKEN, ROLE_REPOSITORY, USER_REPOSITORY } from '../../common/constants.js';
import { LoginAttemptService } from '../../common/security/login-attempt.service.js';
import { PasswordService } from '../../common/security/password.service.js';
import type { RoleRepository } from '../../database/repositories/role.repository.js';
import type { User, UserRepository } from '../../database/repositories/user.repository.js';
import type { AuthenticatedUser } from '../../rbac-core/index.js';
import type { LoginDto, RefreshDto, RegisterDto } from './dto/index.js';

/** The seeded role every self-registered account gets (plan.md §5 baseline). */
const DEFAULT_ROLE_NAME = 'user';

/** One message for every credential failure — see `verifyCredentials` (spec §1 rules). */
const INVALID_CREDENTIALS = 'Invalid email or password';

/**
 * A real argon2id hash of a value no client can supply, used only so that a login for an
 * email with no account still pays one full argon2 verification. Without it, response
 * time alone would reveal whether the account exists (spec §1 rules).
 */
const ABSENT_USER_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$PF5HUxwmNoeOwdijA/cUxQ$c74olkajvlDbWd85Gu4kFUFzUzcZ4vbW/91buVimmpE';

/**
 * Credential verification and auth-flow orchestration — plan.md §6.
 *
 * Design B (CONTRACTS.md §3): this service resolves the user and checks the password;
 * the injected `IAuthStrategy` only issues/validates the session for an already-verified
 * user, so no strategy ever sees a credential. The four public methods are the frozen
 * surface the REST controller and the GraphQL resolver both call.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(AUTH_STRATEGY_TOKEN) private readonly strategy: IAuthStrategy,
    private readonly passwords: PasswordService,
    private readonly attempts: LoginAttemptService,
  ) {}

  async register(dto: RegisterDto, meta: RequestMeta): Promise<AuthResult> {
    const user = await this.createUser(dto);
    await this.assignDefaultRole(user.id);
    return this.issueSession(user, meta);
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthResult> {
    const email = normalizeEmail(dto.email);
    await this.assertNotLocked(email);
    const user = await this.verifyCredentials(email, dto.password);
    await this.attempts.clear(email);
    assertAccountIsActive(user);
    return this.issueSession(user, meta);
  }

  /** Rotation and reuse detection belong to the strategy (spec §3) — nothing to redo here. */
  async refresh(dto: RefreshDto, meta: RequestMeta): Promise<AuthResult> {
    return this.strategy.refresh(dto.refreshToken, meta);
  }

  async logout(user: AuthenticatedUser, sessionRef: unknown): Promise<void> {
    await this.strategy.logout(user.id, sessionRef);
  }

  private async createUser(dto: RegisterDto): Promise<User> {
    const email = normalizeEmail(dto.email);
    await this.assertEmailIsAvailable(email);
    const passwordHash = await this.passwords.hash(dto.password);
    return this.users.create({ email, passwordHash });
  }

  private async assertEmailIsAvailable(email: string): Promise<void> {
    // Best effort — a concurrent duplicate still hits the DB unique constraint.
    if (await this.users.findByEmail(email)) throw new ConflictException('Email already registered');
  }

  private async assignDefaultRole(userId: string): Promise<void> {
    const role = await this.roles.findByName(DEFAULT_ROLE_NAME);
    if (!role) throw new InternalServerErrorException(`Default role "${DEFAULT_ROLE_NAME}" is missing`);
    await this.users.assignRole(userId, role.id);
  }

  /**
   * The cheap check runs first (spec §6) — a locked address is refused before any argon2
   * work — but the reply is the generic one, so it never confirms the account exists.
   */
  private async assertNotLocked(email: string): Promise<void> {
    if (await this.attempts.isLocked(email)) throw new UnauthorizedException(INVALID_CREDENTIALS);
  }

  private async verifyCredentials(email: string, password: string): Promise<User> {
    const user = await this.users.findByEmail(email);
    // Runs against the dummy hash when the account is absent, so both branches cost one
    // argon2 verification and one identical error below.
    const passwordMatches = await this.passwords.verify(user?.passwordHash ?? ABSENT_USER_HASH, password);
    if (user === null) throw new UnauthorizedException(INVALID_CREDENTIALS);
    if (!passwordMatches) {
      // Only a genuinely wrong password counts (spec §6): an absent address has no account
      // for the lock to protect, so counting it would store pure noise.
      await this.attempts.recordFailure(email);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    return user;
  }

  private async issueSession(user: User, meta: RequestMeta): Promise<AuthResult> {
    const context = await this.users.findRolesAndPermissions(user.id);
    return this.strategy.login(toAuthenticatedUser(user, context), meta);
  }
}

/**
 * The DB stores email as plain text (no `citext`, so MongoDB works) and no ORM adapter
 * normalizes it, so every read and write of an address is lowercased and trimmed HERE.
 * Skipping it lets one person register the same logical address twice and makes login
 * case-sensitive (MEMORY.md, Wave 2 reconciliation).
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertAccountIsActive(user: User): void {
  // Same message as a bad password: a disabled account must not be distinguishable either.
  if (!user.isActive) throw new UnauthorizedException(INVALID_CREDENTIALS);
}

function toAuthenticatedUser(user: User, context: { roles: string[]; permissions: string[] }): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    isActive: user.isActive,
    isEmailVerified: user.isEmailVerified,
    roles: context.roles,
    permissions: context.permissions,
  };
}
