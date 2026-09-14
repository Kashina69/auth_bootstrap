import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../constants.js';
import { Roles } from './roles.decorator.js';

describe('@Roles()', () => {
  it('records the role names verbatim, in order', () => {
    const handler = (): void => undefined;

    Roles('admin', 'superadmin')(handler);

    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['admin', 'superadmin']);
  });

  it('records an empty list rather than no metadata when called with no roles', () => {
    const handler = (): void => undefined;

    Roles()(handler);

    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([]);
  });

  it('does not invent a role for an undecorated handler', () => {
    expect(Reflect.getMetadata(ROLES_KEY, (): void => undefined)).toBeUndefined();
  });
});
