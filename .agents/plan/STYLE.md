# STYLE.md — Code-Style Contract (binding on every agent)

This is the style contract every worker agent's output is checked against before the
orchestrator accepts a wave. Paste it in full into every worker's dispatch prompt.

- **Minimal over clever.** No abstraction, pattern, or generic that isn't needed by
  something that already exists in `PLAN.md`. If a "just in case" hook, config option,
  or extension point isn't used by Wave 8, delete it — don't leave it half-built for a
  future need.
- **Every module/strategy is a plugin.** Each `auth-strategies/*`, `rbac-strategies/*`,
  and `database/repositories/*` implementation must be deletable as a whole folder
  without breaking anything outside it, and replaceable by swapping the one DI provider
  that constructs it. If removing a folder requires touching more than the one factory
  in `*.module.ts`, the boundary is wrong — fix the boundary, don't patch around it.
- **Compose small named functions, not classes full of logic.** Prefer plain functions
  with descriptive verb-first names (`hashPassword`, `rotateRefreshToken`,
  `resolveUserPermissions`) over deep class hierarchies or inheritance. NestJS
  providers/services can still be classes (that's the framework's DI shape), but a
  service method's body should mostly be short, named function calls — not inlined logic.
- **Top-down readability: each layer reads like pseudocode of the layer below it.** A
  reviewer should be able to read `authService.login()` top to bottom and understand the
  entire flow from the function names alone, without opening any of the functions it
  calls:

  ```ts
  async function login(credentials: LoginDto, meta: RequestMeta): Promise<AuthResult> {
    const user = await verifyCredentials(credentials);
    assertAccountIsActive(user);
    const context = await resolveAuthzContext(user);
    return issueAuthResult(user, context, meta);
  }
  ```

  Then `verifyCredentials`, `assertAccountIsActive`, etc. are themselves short and read
  the same way one level down. No function should mix "what happens" with "how it
  happens" — if a function body has both a sequence of named steps *and* raw logic
  (loops, conditionals, DB calls) at the same level, split the raw logic out into its own
  named function.
- **Names carry the explanation.** If a function needs a comment to explain what it does,
  rename it instead. Comments are for *why* (a non-obvious tradeoff, a spec quirk), never
  for *what*.
- **Follow NestJS conventions as the default, not a departure from them:** constructor
  injection over manual instantiation, DTOs + `class-validator` for every input boundary,
  guards/interceptors/pipes for cross-cutting concerns instead of inline checks scattered
  in services, one responsibility per module. "Minimalistic" means no extra layers on top
  of Nest's own idioms — not skipping the idioms.

- **A globally-registered enhancer must handle every transport the app serves.** Anything
  registered via `APP_GUARD` / `APP_INTERCEPTOR` / `APP_FILTER` or `app.useGlobal*()` runs for
  **GraphQL resolvers as well as HTTP routes**. Never call `context.switchToHttp()` /
  `host.switchToHttp()` unconditionally — branch on `context.getType<'graphql'>() === 'graphql'`
  and use `GqlExecutionContext`, the way `common/guards/auth.guard.ts` does. Wave 7 lost three
  separate runtime crashes (interceptor, exception filter, throttler guard) to this, none of
  which the build, tests, typecheck, lint, a clean boot, or a code-reading review could see.
  **Corollary:** do not "fix" such a crash by *skipping* the enhancer for non-HTTP contexts —
  that silently removes the protection from the GraphQL surface, which for an auth guard is a
  bypass, not a convenience.

## Orchestrator enforcement

As part of the Wave conformance check, reject any diff where:

- a service/controller method body is longer than ~15–20 lines of non-function-call
  logic, or
- a strategy/repository implementation can't be deleted as a self-contained folder.

Send it back to the worker with the specific function to split, not a general "simplify
this" note.
