export interface AuthzContext {
  roles: string[];
  permissions: string[]; // "action:subject" strings, e.g. "manage:all"
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  isActive: boolean;
  isEmailVerified: boolean;
  // Populated ONLY by the embedded-claims RBAC strategy (baked into the JWT/session at
  // login/refresh). db-live leaves these empty and resolves them via a live DB lookup in
  // IAuthorizationProvider.getContext(). Guards never trust a client-supplied value here.
  roles?: string[];
  permissions?: string[];
}
