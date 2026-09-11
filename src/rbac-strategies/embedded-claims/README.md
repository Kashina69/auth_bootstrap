# RBAC strategy A — `embedded-claims`

Default `RBAC_STRATEGY` (`CONTRACTS.md` §7). Roles and resolved `action:subject`
permission strings ride along inside the auth payload itself, so every request is an
in-memory `can()` check with no DB or cache round-trip. Trade-off table: `plan.md` §3.3.

## The two halves of the contract (they live in different folders)

```
 login/refresh                          every request
 ─────────────                          ─────────────
 auth-strategies/*                      AuthGuard  → verifies token/session
   resolve user's roles+permissions                 → req.user (AuthenticatedUser,
   (auth service, modules/auth/)                      roles/permissions included)
   bake them into the payload                       ↓
        ↓                              RbacGuard → IAuthorizationProvider.getContext(user)
   JWT claim / Redis session blob                     → AuthzContext{ roles, permissions }
   (only when RBAC_STRATEGY ===                       → rbac-core.can(...)
    'embedded-claims')                                 (no DB, no cache)
```

- **Write side:** `auth-strategies/jwt-stateless/` embeds the claims in the JWT when
  `config.RBAC_STRATEGY === 'embedded-claims'`; `auth-strategies/session-redis/` stores
  them in the session blob. The auth service (`modules/auth/`) does the resolution and
  hands the populated `AuthenticatedUser` to `IAuthStrategy.login()`.
- **Read side:** `embedded-claims.authorization-provider.ts` (this folder). It only reads
  what is already on the verified `user` object — a client-supplied `roles`/`permissions`
  body field is never consulted.

## Why `invalidate()` is a no-op here

`db-live` keeps a server-side context cache and must clear a user's entry the moment a
role/permission changes (`plan.md` §5, migration note). Embedded claims are not cached
anywhere this process can reach — they are a copy inside the caller's token/session — so
there is nothing to clear. Revocation latency is therefore bounded by the token/session
TTL: a demoted user keeps their old claims until the next login/refresh.

## Deny by default

`getContext()` normalizes both claim lists to `string[]`, defaulting to `[]` for anything
malformed or absent (a token minted before claims were baked in, a hand-rolled
`request.user`). An empty context makes `rbac-core.can()` return `false`, never `true`.

## Deleting this folder

Remove the `embedded-claims` case from `createAuthorizationProvider()` in
`rbac-strategies.module.ts` (and the provider's own write-side branch in the auth
strategies) — nothing else references this class. `RbacGuard` injects only
`AUTHZ_PROVIDER_TOKEN`.
