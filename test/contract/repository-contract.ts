import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRepository } from '../../src/database/repositories/permission.repository.js';
import type { RefreshTokenRepository } from '../../src/database/repositories/refresh-token.repository.js';
import type { RoleRepository } from '../../src/database/repositories/role.repository.js';
import type { UserRepository } from '../../src/database/repositories/user.repository.js';

/**
 * The behavioural contract every one of the four ORM adapters must satisfy. It asserts
 * CONTRACTS.md §5 — never what one adapter happens to do — so a divergence shows up as a
 * failing provider rather than as a weakened shared expectation.
 *
 * **What this file proves about the schema:** the DDL every provider is run against is the
 * shipped migrations, replayed verbatim. It used to be migrations *plus* a test-time patch
 * that reconciled two drifts (missing column defaults; `TIMESTAMP(3)` vs `timestamptz`),
 * which meant the contract held only for a schema production did not have. Both are now
 * fixed in `20260914000001_timestamptz_and_column_defaults`, so a reappearance of either
 * fails this suite instead of being patched away — removing that migration produces 23
 * Drizzle failures.
 *
 * The provider-specific parts (clients, migrations, truncation, raw reads) live in each
 * spec's factory; nothing ORM-shaped belongs in this file.
 */

export interface ContractHarness {
  readonly users: UserRepository;
  readonly roles: RoleRepository;
  readonly permissions: PermissionRepository;
  readonly refreshTokens: RefreshTokenRepository;
  /** Empty every table/collection, so no test can observe another's rows (TEST-PLAN §7.4). */
  reset(): Promise<void>;
  /** Sets `deletedAt`. No repository method does this — the finders' soft-delete filter is the thing under test. */
  softDeleteUser(id: string): Promise<void>;
  /** The persisted refresh-token storage, read directly, as text. */
  dumpRefreshTokens(): Promise<string>;
  close(): Promise<void>;
}

export type RepositoryFactory = () => Promise<ContractHarness>;

export function defineRepositoryContract(name: string, createHarness: RepositoryFactory): void {
  describe(name, () => {
    let h: ContractHarness;

    beforeAll(async () => {
      h = await createHarness();
    });
    beforeEach(async () => {
      await h.reset();
    });
    afterAll(async () => {
      await h.close();
    });

    describe('UserRepository', () => {
      it('findById returns null for an id that was never stored', async () => {
        expect(await h.users.findById(randomUUID())).toBeNull();
      });

      it('findByEmail returns null for an address that was never stored', async () => {
        expect(await h.users.findByEmail('nobody@example.com')).toBeNull();
      });

      it('create round-trips every field of the entity', async () => {
        const created = await h.users.create({
          email: 'round-trip@example.com',
          passwordHash: 'hash-before',
        });

        expect(created.id).toEqual(expect.any(String));
        expect(created.email).toBe('round-trip@example.com');
        expect(created.passwordHash).toBe('hash-before');
        // The defaults are part of the contract, not an adapter detail: a freshly
        // created account is active, unverified, and not soft-deleted.
        expect(created.isActive).toBe(true);
        expect(created.isEmailVerified).toBe(false);
        expect(created.deletedAt).toBeNull();
        expect(created.createdAt).toBeInstanceOf(Date);
        expect(created.updatedAt).toBeInstanceOf(Date);

        expect(await h.users.findById(created.id)).toEqual(created);
      });

      // The contract pins exact-match lookup, NOT case-insensitivity. Mongoose lowercases
      // the address on both writes and reads; the other three compare byte-for-byte against
      // what was stored. Asserting a mixed-case lookup here would encode one adapter's
      // behaviour as the contract (WAVE-LOG S10) — so the divergence is left visible
      // instead of being averaged away.
      it('findByEmail matches the stored address exactly', async () => {
        const created = await h.users.create({
          email: 'exact-match@example.com',
          passwordHash: 'hash',
        });

        const found = await h.users.findByEmail('exact-match@example.com');
        expect(found).toEqual(created);
      });

      it('updatePassword replaces the stored hash and nothing else', async () => {
        const created = await h.users.create({
          email: 'rotate@example.com',
          passwordHash: 'hash-before',
        });

        await h.users.updatePassword(created.id, 'hash-after');

        const reloaded = await h.users.findById(created.id);
        expect(reloaded?.passwordHash).toBe('hash-after');
        expect(reloaded?.email).toBe('rotate@example.com');
      });

      it('findById and findByEmail both hide a soft-deleted user', async () => {
        const created = await h.users.create({
          email: 'soft-deleted@example.com',
          passwordHash: 'hash',
        });
        // Guard the guard: the user must be findable before the flag is set, otherwise a
        // broken finder would pass this test for the wrong reason.
        expect(await h.users.findById(created.id)).not.toBeNull();

        await h.softDeleteUser(created.id);

        expect(await h.users.findById(created.id)).toBeNull();
        expect(await h.users.findByEmail('soft-deleted@example.com')).toBeNull();
      });

      it('assignRole is idempotent', async () => {
        const user = await h.users.create({ email: 'assignee@example.com', passwordHash: 'h' });
        const role = await h.roles.create({ name: 'assign-role-target' });

        await h.users.assignRole(user.id, role.id);
        await h.users.assignRole(user.id, role.id);

        const { roles } = await h.users.findRolesAndPermissions(user.id);
        expect(roles).toEqual(['assign-role-target']);
        expect(await h.users.findUserIdsByRole(role.id)).toEqual([user.id]);
      });

      it('findRolesAndPermissions returns role names and de-duplicated permission names', async () => {
        const editor = await h.roles.create({ name: 'ctx-editor' });
        const auditor = await h.roles.create({ name: 'ctx-auditor' });
        const readPost = await h.permissions.create({ action: 'read', subject: 'Article' });
        const writePost = await h.permissions.create({ action: 'write', subject: 'Article' });

        await h.roles.attachPermissions(editor.id, [readPost.id, writePost.id]);
        // `read:Article` is granted by both roles — it must collapse to one entry, because
        // this list travels in the JWT payload (plan.md §4).
        await h.roles.attachPermissions(auditor.id, [readPost.id]);

        const user = await h.users.create({ email: 'multi-role@example.com', passwordHash: 'h' });
        await h.users.assignRole(user.id, editor.id);
        await h.users.assignRole(user.id, auditor.id);

        const context = await h.users.findRolesAndPermissions(user.id);
        expect([...context.roles].sort()).toEqual(['ctx-auditor', 'ctx-editor']);
        expect([...context.permissions].sort()).toEqual(['read:Article', 'write:Article']);
      });

      it('findRolesAndPermissions is empty for a user with no roles', async () => {
        const user = await h.users.create({ email: 'roleless@example.com', passwordHash: 'h' });

        expect(await h.users.findRolesAndPermissions(user.id)).toEqual({
          roles: [],
          permissions: [],
        });
      });

      it('findUserIdsByRole returns exactly the holders of that role', async () => {
        const role = await h.roles.create({ name: 'holders-only' });
        const holderA = await h.users.create({ email: 'holder-a@example.com', passwordHash: 'h' });
        const holderB = await h.users.create({ email: 'holder-b@example.com', passwordHash: 'h' });
        const outsider = await h.users.create({ email: 'outsider@example.com', passwordHash: 'h' });

        await h.users.assignRole(holderA.id, role.id);
        await h.users.assignRole(holderB.id, role.id);

        const ids = await h.users.findUserIdsByRole(role.id);
        expect([...ids].sort()).toEqual([holderA.id, holderB.id].sort());
        expect(ids).not.toContain(outsider.id);
      });
    });

    describe('RoleRepository', () => {
      it('findById and findByName return null for a role that was never stored', async () => {
        expect(await h.roles.findById(randomUUID())).toBeNull();
        expect(await h.roles.findByName('no-such-role')).toBeNull();
      });

      it('create round-trips name, description and isSystem on both paths', async () => {
        const baseline = await h.roles.create({
          name: 'baseline-superadmin',
          description: 'seeded',
          isSystem: true,
        });
        const adHoc = await h.roles.create({ name: 'baseline-ad-hoc' });

        expect(baseline.isSystem).toBe(true);
        expect(baseline.description).toBe('seeded');
        expect(adHoc.isSystem).toBe(false);
        expect(adHoc.description).toBeNull();

        // `isSystem` decides whether the RBAC admin API may delete the row (plan.md §5.4),
        // so it must survive the round trip and not just the create() return value.
        expect((await h.roles.findById(baseline.id))?.isSystem).toBe(true);
        expect((await h.roles.findByName('baseline-ad-hoc'))?.isSystem).toBe(false);
      });

      it('findAll contains every stored role', async () => {
        await h.roles.create({ name: 'all-role-a' });
        await h.roles.create({ name: 'all-role-b' });

        const names = (await h.roles.findAll()).map((role) => role.name);
        expect(names).toContain('all-role-a');
        expect(names).toContain('all-role-b');
      });

      it('attachPermissions grants, and listPermissions reads the grants back', async () => {
        const role = await h.roles.create({ name: 'granted-role' });
        const read = await h.permissions.create({ action: 'read', subject: 'Grant' });
        const write = await h.permissions.create({ action: 'write', subject: 'Grant' });

        await h.roles.attachPermissions(role.id, [read.id, write.id]);

        const granted = (await h.roles.listPermissions(role.id)).map((p) => p.name).sort();
        expect(granted).toEqual(['read:Grant', 'write:Grant']);
      });

      it('attachPermissions is idempotent', async () => {
        const role = await h.roles.create({ name: 'reattach-role' });
        const permission = await h.permissions.create({ action: 'read', subject: 'Reattach' });

        await h.roles.attachPermissions(role.id, [permission.id]);
        await h.roles.attachPermissions(role.id, [permission.id]);

        expect(await h.roles.listPermissions(role.id)).toHaveLength(1);
      });

      it('detachPermissions removes the grant, and is idempotent', async () => {
        const role = await h.roles.create({ name: 'detach-role' });
        const kept = await h.permissions.create({ action: 'read', subject: 'Detach' });
        const dropped = await h.permissions.create({ action: 'write', subject: 'Detach' });
        await h.roles.attachPermissions(role.id, [kept.id, dropped.id]);

        await h.roles.detachPermissions(role.id, [dropped.id]);
        const remaining = await h.roles.listPermissions(role.id);
        expect(remaining.map((p) => p.name)).toEqual(['read:Detach']);

        await expect(h.roles.detachPermissions(role.id, [dropped.id])).resolves.toBeUndefined();
        expect(await h.roles.listPermissions(role.id)).toHaveLength(1);
      });

      it('delete removes the role', async () => {
        const role = await h.roles.create({ name: 'doomed-role' });

        await h.roles.delete(role.id);

        expect(await h.roles.findById(role.id)).toBeNull();
        expect(await h.roles.findByName('doomed-role')).toBeNull();
      });
    });

    describe('PermissionRepository', () => {
      it('findById and findByName return null for a permission that was never stored', async () => {
        expect(await h.permissions.findById(randomUUID())).toBeNull();
        expect(await h.permissions.findByName('no-such:Permission')).toBeNull();
      });

      it('create derives name from action and subject, and round-trips isSystem', async () => {
        const baseline = await h.permissions.create({
          action: 'update',
          subject: 'Permission',
          description: 'seeded',
          isSystem: true,
        });
        const adHoc = await h.permissions.create({ action: 'list', subject: 'Permission' });

        expect(baseline.name).toBe('update:Permission');
        expect(baseline.isSystem).toBe(true);
        expect(adHoc.isSystem).toBe(false);
        expect(adHoc.description).toBeNull();

        // `isSystem` is what stops the RBAC admin API deleting a baseline permission
        // (plan.md §5.4) — the Wave 6 defect was exactly this flag not persisting.
        expect((await h.permissions.findByName('update:Permission'))?.isSystem).toBe(true);
        expect((await h.permissions.findById(baseline.id))?.isSystem).toBe(true);
        expect((await h.permissions.findById(adHoc.id))?.isSystem).toBe(false);
      });

      it('findAll contains every stored permission', async () => {
        await h.permissions.create({ action: 'read', subject: 'All' });
        await h.permissions.create({ action: 'write', subject: 'All' });

        const names = (await h.permissions.findAll()).map((permission) => permission.name);
        expect(names).toContain('read:All');
        expect(names).toContain('write:All');
      });

      it('delete removes the permission', async () => {
        const permission = await h.permissions.create({ action: 'read', subject: 'Doomed' });

        await h.permissions.delete(permission.id);

        expect(await h.permissions.findById(permission.id)).toBeNull();
        expect(await h.permissions.findByName('read:Doomed')).toBeNull();
      });
    });

    describe('RefreshTokenRepository', () => {
      it('findByHash returns null for a hash that was never stored', async () => {
        expect(await h.refreshTokens.findByHash(sha256('never-stored'))).toBeNull();
      });

      it('create round-trips the record', async () => {
        const user = await h.users.create({ email: 'token-owner@example.com', passwordHash: 'h' });
        const raw = rawToken();
        const familyId = randomUUID();
        const expiresAt = new Date(Date.now() + 60_000);

        await h.refreshTokens.create({
          userId: user.id,
          tokenHash: sha256(raw),
          familyId,
          userAgent: 'contract-agent/1.0',
          ip: '203.0.113.7',
          expiresAt,
        });

        const record = await h.refreshTokens.findByHash(sha256(raw));
        expect(record).not.toBeNull();
        expect(record?.userId).toBe(user.id);
        expect(record?.tokenHash).toBe(sha256(raw));
        expect(record?.familyId).toBe(familyId);
        expect(record?.userAgent).toBe('contract-agent/1.0');
        expect(record?.ip).toBe('203.0.113.7');
        expect(record?.revokedAt).toBeNull();
        expect(record?.id).toEqual(expect.any(String));
        expect(record?.createdAt).toBeInstanceOf(Date);
        expect(record?.expiresAt.getTime()).toBe(expiresAt.getTime());
      });

      it('persists only the SHA-256 hash, never the raw token', async () => {
        const user = await h.users.create({ email: 'hash-at-rest@example.com', passwordHash: 'h' });
        const raw = rawToken();

        await h.refreshTokens.create({
          userId: user.id,
          tokenHash: sha256(raw),
          familyId: randomUUID(),
          userAgent: 'contract-agent/1.0',
          ip: '203.0.113.7',
          expiresAt: new Date(Date.now() + 60_000),
        });

        // The raw token is not a lookup key at all.
        expect(await h.refreshTokens.findByHash(raw)).toBeNull();

        // And it is not on disk: read the storage directly, because asking the repository
        // whether it stored the secret is asking the suspect for an alibi.
        const dump = await h.dumpRefreshTokens();
        expect(dump).toContain(sha256(raw));
        expect(dump).not.toContain(raw);
      });

      it('markRevoked revokes only the row it is given', async () => {
        const user = await h.users.create({ email: 'mark-revoked@example.com', passwordHash: 'h' });
        const doomed = rawToken();
        const survivor = rawToken();
        await storeToken(h, user.id, doomed, randomUUID());
        await storeToken(h, user.id, survivor, randomUUID());

        const record = await h.refreshTokens.findByHash(sha256(doomed));
        await h.refreshTokens.markRevoked(record!.id);

        expect((await h.refreshTokens.findByHash(sha256(doomed)))?.revokedAt).toBeInstanceOf(Date);
        expect((await h.refreshTokens.findByHash(sha256(survivor)))?.revokedAt).toBeNull();
      });

      it('revokeFamily revokes exactly one family', async () => {
        const user = await h.users.create({ email: 'family@example.com', passwordHash: 'h' });
        const reuseChain = randomUUID();
        const otherChain = randomUUID();
        const first = rawToken();
        const rotated = rawToken();
        const unrelated = rawToken();
        await storeToken(h, user.id, first, reuseChain);
        await storeToken(h, user.id, rotated, reuseChain);
        await storeToken(h, user.id, unrelated, otherChain);

        await h.refreshTokens.revokeFamily(reuseChain);

        expect((await h.refreshTokens.findByHash(sha256(first)))?.revokedAt).toBeInstanceOf(Date);
        expect((await h.refreshTokens.findByHash(sha256(rotated)))?.revokedAt).toBeInstanceOf(Date);
        expect((await h.refreshTokens.findByHash(sha256(unrelated)))?.revokedAt).toBeNull();
      });

      it('revokeAllForUser revokes exactly one user', async () => {
        const target = await h.users.create({ email: 'revoke-me@example.com', passwordHash: 'h' });
        const bystander = await h.users.create({ email: 'bystander@example.com', passwordHash: 'h' });
        const targetA = rawToken();
        const targetB = rawToken();
        const bystanderToken = rawToken();
        await storeToken(h, target.id, targetA, randomUUID());
        await storeToken(h, target.id, targetB, randomUUID());
        await storeToken(h, bystander.id, bystanderToken, randomUUID());

        await h.refreshTokens.revokeAllForUser(target.id);

        expect((await h.refreshTokens.findByHash(sha256(targetA)))?.revokedAt).toBeInstanceOf(Date);
        expect((await h.refreshTokens.findByHash(sha256(targetB)))?.revokedAt).toBeInstanceOf(Date);
        expect((await h.refreshTokens.findByHash(sha256(bystanderToken)))?.revokedAt).toBeNull();
      });
    });
  });
}

/** A raw refresh token — only ever hashed on the way in. */
function rawToken(): string {
  return `raw-token-${randomUUID()}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function storeToken(
  harness: ContractHarness,
  userId: string,
  raw: string,
  familyId: string,
): Promise<void> {
  await harness.refreshTokens.create({
    userId,
    tokenHash: sha256(raw),
    familyId,
    userAgent: 'contract-agent/1.0',
    ip: '203.0.113.7',
    expiresAt: new Date(Date.now() + 60_000),
  });
}
