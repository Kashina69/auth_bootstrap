import { can, hasAnyPermission, hasRole } from './can.js';
import { createPolicyRegistry } from './policy-registry.js';

describe('can', () => {
  it('grants everything for manage:all', () => {
    expect(can({ roles: [], permissions: ['manage:all'] }, 'delete', 'Post')).toBe(true);
  });

  it('grants any action on the subject for manage:{subject}', () => {
    expect(can({ roles: [], permissions: ['manage:Post'] }, 'delete', 'Post')).toBe(true);
  });

  it('denies a different action on the subject', () => {
    expect(can({ roles: [], permissions: ['read:Post'] }, 'delete', 'Post')).toBe(false);
  });

  it('denies when no permissions are held', () => {
    expect(can({ roles: [], permissions: [] }, 'read', 'Post')).toBe(false);
  });

  it('denies malformed input instead of throwing', () => {
    expect(can(undefined as any, 'read', 'Post')).toBe(false);
  });

  it('treats the subject as case-sensitive', () => {
    expect(can({ roles: [], permissions: ['read:Post'] }, 'read', 'post')).toBe(false);
  });

  it('denies a constructor-named permission that is not an own set member', () => {
    expect(can({ roles: [], permissions: [] }, 'read', 'constructor')).toBe(false);
  });
});

describe('hasRole', () => {
  it('finds a held role', () => {
    expect(hasRole({ roles: ['admin'], permissions: [] }, 'admin')).toBe(true);
  });

  it('does not find an unheld role', () => {
    expect(hasRole({ roles: ['admin'], permissions: [] }, 'editor')).toBe(false);
  });
});

describe('hasAnyPermission', () => {
  it('matches any one of the given permissions', () => {
    expect(hasAnyPermission({ roles: [], permissions: ['read:Post'] }, ['delete:Post', 'read:Post'])).toBe(true);
  });

  it('matches anything when manage:all is held', () => {
    expect(hasAnyPermission({ roles: [], permissions: ['manage:all'] }, ['delete:Post'])).toBe(true);
  });

  it('denies when none of the given permissions are held', () => {
    expect(hasAnyPermission({ roles: [], permissions: ['read:Post'] }, ['delete:Post'])).toBe(false);
  });
});

describe('createPolicyRegistry', () => {
  const registry = createPolicyRegistry({
    admin: ['manage:all'],
    editor: ['read:Post', 'update:Post'],
    viewer: ['read:Post'],
  });

  it('resolves a context from a single role', () => {
    expect(registry.resolveContext(['editor'])).toEqual({
      roles: ['editor'],
      permissions: ['read:Post', 'update:Post'],
    });
  });

  it('unions the permissions of every held role without duplicates', () => {
    expect(registry.resolveContext(['editor', 'viewer'])).toEqual({
      roles: ['editor', 'viewer'],
      permissions: ['read:Post', 'update:Post'],
    });
  });

  it('resolves a context that can() accepts for a role-derived permission', () => {
    expect(can(registry.resolveContext(['editor']), 'update', 'Post')).toBe(true);
    expect(can(registry.resolveContext(['viewer']), 'update', 'Post')).toBe(false);
  });

  it('ignores roles it does not know', () => {
    expect(registry.resolveContext(['unknown'])).toEqual({ roles: ['unknown'], permissions: [] });
  });
});
