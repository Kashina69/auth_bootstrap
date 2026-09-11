import type { AuthzContext } from './types.js';

export function can(ctx: AuthzContext, action: string, subject: string): boolean {
  if (!ctx || !Array.isArray(ctx.permissions)) return false; // deny by default on malformed input
  const perms = new Set(ctx.permissions);
  // `subject` is case-sensitive and must match permissions.subject verbatim.
  return perms.has('manage:all') || perms.has(`manage:${subject}`) || perms.has(`${action}:${subject}`);
}

export function hasRole(ctx: AuthzContext, role: string): boolean {
  return ctx.roles.includes(role);
}

export function hasAnyPermission(ctx: AuthzContext, perms: string[]): boolean {
  return perms.some((p) => ctx.permissions.includes(p) || ctx.permissions.includes('manage:all'));
}
