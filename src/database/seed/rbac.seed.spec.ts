import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `rbac.seed.ts` self-invokes `main()` on import (top-level await, real `DatabaseModule`,
 * real connection), so it cannot be imported by a unit test — idempotency across two runs
 * is the contract suite's job.
 *
 * **What this file proves, and what it does not.** It validates the *baseline data* against
 * the grammar the seeder demands: `resolveGrant` throws on a grant with no colon, so a typo in
 * `rbac.seed.json` is a boot-time failure, and this catches that without a database.
 *
 * It does **not** test the seeder's code. `splitGrant` / `permissionName` below are a
 * transcription of the private rule in `resolveGrant` (`rbac.seed.ts`, "split on the FIRST
 * colon") — if that rule changes, these assertions will not follow it, because they test the
 * copy. The helper is a stand-in for the rule, not a reference to it; anything that must fail
 * when the *seeder* changes belongs in the contract suite.
 */
interface SeedFile {
  permissions: Array<{ action: string; subject: string }>;
  roles: Array<{ name: string; isSystem: boolean; permissions: string[] }>;
}

const baseline = JSON.parse(
  readFileSync(new URL('./rbac.seed.json', import.meta.url), 'utf8'),
) as SeedFile;

/** The seeder's own identity rule: split on the FIRST colon. */
function permissionName(action: string, subject: string): string {
  return `${action}:${subject}`;
}

function splitGrant(name: string): [string, string] | null {
  const separator = name.indexOf(':');
  if (separator === -1) return null;
  return [name.slice(0, separator), name.slice(separator + 1)];
}

const declaredNames = baseline.permissions.map((permission) =>
  permissionName(permission.action, permission.subject),
);
const grantedNames = baseline.roles.flatMap((role) => role.permissions);

describe('the RBAC baseline', () => {
  it('declares every permission with both halves present', () => {
    for (const permission of baseline.permissions) {
      expect(permission.action).not.toBe('');
      expect(permission.subject).not.toBe('');
    }
  });

  it('declares each permission exactly once', () => {
    // A duplicate name would make the seeder's findOrCreate return whichever row it found
    // first, leaving two permission rows for one identity.
    expect(new Set(declaredNames).size).toBe(declaredNames.length);
  });

  it('grants only names the seeder can parse into an action and a subject', () => {
    // `resolveGrant` throws on a name with no colon; this is the seed's input contract.
    for (const name of grantedNames) {
      expect(splitGrant(name)).not.toBeNull();
      expect(splitGrant(name)![0]).not.toBe('');
      expect(splitGrant(name)![1]).not.toBe('');
    }
  });

  it('survives a subject that itself contains a colon', () => {
    // Splitting on the first colon only is what keeps such a grant from being truncated.
    expect(splitGrant('update:Sub:Thing')).toEqual(['update', 'Sub:Thing']);
  });

  it('gives every role a unique name', () => {
    const names = baseline.roles.map((role) => role.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks at least one role as a system role, so something is undeletable by the admin API', () => {
    expect(baseline.roles.some((role) => role.isSystem)).toBe(true);
  });

  it('grants at least one permission the declared list does not carry, exercising the on-demand upsert', () => {
    // The shipped `admin` role grants `manage:Post`, which `permissions[]` never declares.
    // That is deliberate — `resolveGrant` upserts it on demand — and it means the branch is
    // exercised by every real seed run rather than being dead code.
    expect(grantedNames.filter((name) => !declaredNames.includes(name))).toEqual(['manage:Post']);
  });
});
