
# Auth + RBAC Bootstrap — Multi-Agent Execution Plan

This restructures the implementation plan into an **orchestrator + subagent** build, so the work runs as parallel/sequential agent waves instead of one linear pass. It follows the same shape as your existing review-agent system: a top-level orchestrating agent, scoped worker agents, and shared markdown context files instead of one agent holding everything in its head.

---

## 0. Orchestrator: `auth-rbac-bootstrap-agent`

**Role:** Owns the build. Does not write feature code itself. Responsibilities:

1. Create/maintain the shared context files (§1), including `STYLE.md` (§1.1), before dispatching any worker.
2. Dispatch each wave (§3) — for Claude Code, this means firing off the wave's agents as parallel subagent tasks (`Task` tool / parallel subagent invocations) and blocking on all of them before starting the next wave. Every dispatch prompt includes `STYLE.md` in full, not just `CONTRACTS.md` and the relevant `PLAN.md` slice.
3. After each wave, run a **contract-conformance and style-conformance check**: read every worker's diff, confirm it only touched its owned paths (§2), didn't change any interface signature without updating `CONTRACTS.md`, and follows `STYLE.md` (§1.1's enforcement rule).
4. Merge, resolve any cross-agent conflicts, update `MEMORY.md` with what shipped, then dispatch the next wave.
5. At the end, run `test-agent` and `security-hardening-agent` as the closing wave, then produce a final summary diffed against §11 of the original plan (Build Phases) so you can confirm nothing was dropped.

**Kickoff prompt for this agent** (adapt to however you invoke subagents in this repo):

> You are `auth-rbac-bootstrap-agent`. Read `CONTRACTS.md`, `MEMORY.md`, and `PLAN.md` in this feature's working folder before doing anything. Dispatch Wave 1. Do not let any worker agent touch a file outside its owned path list. After each wave, verify conformance before dispatching the next. Stop and ask me before merging if two agents touched the same interface differently.

---

## 1. Shared context files (write these *before* Wave 1)

Every worker agent reads these four files as its entire shared context — this is what lets four agents work in parallel without stepping on each other or re-deriving the architecture:

| File Contents    |                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAN.md`      | The original plan document (verbatim), scoped down per-agent in each dispatch prompt                                                                                                                                                                                                                            |
| `CONTRACTS.md` | The frozen interfaces every agent codes against:`IAuthStrategy`, `IAuthorizationProvider`, `UserRepository`/`RoleRepository`/`PermissionRepository`, `AuthzContext`, `AuthResult`, DTO shapes. **Interface changes require orchestrator sign-off**, not a worker unilaterally editing them. |
| `STYLE.md`     | The code-style contract (§1.1) — every agent's output is checked against this before the orchestrator accepts a wave.                                                                                                                                                                                         |
| `MEMORY.md`    | Running log: which agent shipped what, in which wave, any deviations from`PLAN.md` and why. Updated by the orchestrator after each wave, not by workers directly — avoids write races.                                                                                                                       |

Seed `CONTRACTS.md` directly from §3.1, §4, and §7 of the plan (the interface definitions and schema) — those are stable enough to freeze before any implementation work starts.

### 1.1 `STYLE.md` — code-style contract (binding on every agent)

Paste this into every worker's dispatch prompt, not just `guards-decorators-agent`'s — style drift between agents is the main way a multi-agent build ends up looking stitched-together.

- **Minimal over clever.** No abstraction, pattern, or generic that isn't needed by something that already exists in `PLAN.md`. If a "just in case" hook, config option, or extension point isn't used by Wave 8, delete it — don't leave it half-built for a future need.
- **Every module/strategy is a plugin.** Each `auth-strategies/*`, `rbac-strategies/*`, and `database/repositories/*` implementation must be deletable as a whole folder without breaking anything outside it, and replaceable by swapping the one DI provider that constructs it. If removing a folder requires touching more than the one factory in `*.module.ts`, the boundary is wrong — fix the boundary, don't patch around it.
- **Compose small named functions, not classes full of logic.** Prefer plain functions with descriptive verb-first names (`hashPassword`, `rotateRefreshToken`, `resolveUserPermissions`) over deep class hierarchies or inheritance. NestJS providers/services can still be classes (that's the framework's DI shape), but a service method's body should mostly be short, named function calls — not inlined logic.
- **Top-down readability: each layer reads like pseudocode of the layer below it.** A reviewer should be able to read `authService.login()` top to bottom and understand the entire flow from the function names alone, without opening any of the functions it calls:
  ```ts
  async function login(credentials: LoginDto, meta: RequestMeta): Promise<AuthResult> {  const user = await verifyCredentials(credentials);  assertAccountIsActive(user);  const context = await resolveAuthzContext(user);  return issueAuthResult(user, context, meta);}

  ```

  Then `verifyCredentials`, `assertAccountIsActive`, etc. are themselves short and read the same way one level down. No function should mix "what happens" with "how it happens" — if a function body has both a sequence of named steps *and* raw logic (loops, conditionals, DB calls) at the same level, split the raw logic out into its own named function.
- **Names carry the explanation.** If a function needs a comment to explain what it does, rename it instead. Comments are for *why* (a non-obvious tradeoff, a spec quirk), never for *what*.
- **Follow NestJS conventions as the default, not a departure from them:** constructor injection over manual instantiation, DTOs + `class-validator` for every input boundary, guards/interceptors/pipes for cross-cutting concerns instead of inline checks scattered in services, one responsibility per module. "Minimalistic" means no extra layers on top of Nest's own idioms — not skipping the idioms.
- **Orchestrator enforcement:** as part of the Wave conformance check (§0.3), reject any diff where a service/controller method body is longer than \~15–20 lines of non-function-call logic, or where a strategy/repository implementation can't be deleted as a self-contained folder. Send it back to the worker with the specific function to split, not a general "simplify this" note.

---

## 2. Worker agents — mission, ownership, and boundaries

Each agent below only ever imports/exports through `CONTRACTS.md` types. None of them import a concrete class from another agent's folder.

### `scaffold-agent`

- **Owns:** `config/`, `main.ts`, `app.module.ts` skeleton, `common/filters`, `common/interceptors`, `common/pipes`, Vitest wiring.
- **Reads:** `PLAN.md` §1, §8 (env schema, zod validation including `AUTH_STRATEGY`/`RBAC_STRATEGY` enums).
- **Ships:** bootable empty Nest app with typed config service, fails fast on bad env.
- **Blocking for:** everyone (Wave 1, solo).

### `db-schema-agent`

- **Owns:** `database/prisma/schema.prisma`, `database/migrations/`, `database/repositories/*.repository.ts` (interfaces + Prisma impls).
- **Reads:** `PLAN.md` §4, §9.
- **Ships:** the six-table schema, repository interfaces registered as DI tokens in `DatabaseModule`, first migration.
- **Must publish into** **`CONTRACTS.md`****:** final `UserRepository`/`RoleRepository`/`PermissionRepository`/`RefreshTokenRepository` method signatures.

### `rbac-core-agent`

- **Owns:** `rbac-core/` only. Zero NestJS/DB imports — this is the hard constraint to police.
- **Reads:** `PLAN.md` §7.
- **Ships:** `types.ts`, `can.ts`, `hasRole`, `hasAnyPermission`, `policy-registry.ts`, unit tests for `can()` in isolation.
- **Runs parallel to** **`db-schema-agent`** (Wave 2) — no dependency between them.

### `strategy-interfaces-agent`

- **Owns:** `auth-strategies/auth-strategy.interface.ts`, `rbac-strategies/authorization-provider.interface.ts`, `AuthStrategiesModule.register()`, `RbacStrategiesModule.register()`, the env-driven factory providers.
- **Reads:** `PLAN.md` §3, plus the repository signatures `db-schema-agent` published to `CONTRACTS.md`.
- **Ships:** the DI-token switch wiring — the actual strategy classes are still stubs at this point (throw `NotImplementedError`), just the plumbing.
- **Wave 3, solo** — every later agent codes against what this one freezes into `CONTRACTS.md`.

### `auth-jwt-agent`

- **Owns:** `auth-strategies/jwt-stateless/`.
- **Reads:** `PLAN.md` §3.3 (strategy A), `IAuthStrategy` from `CONTRACTS.md`.
- **Ships:** argon2 hashing, JWT access/refresh issuance, refresh-token rotation + revocation against `RefreshTokenRepository`.

### `auth-session-agent`

- **Owns:** `auth-strategies/session-redis/`.
- **Reads:** `PLAN.md` §3.3 (strategy B).
- **Ships:** Redis session store, `httpOnly`/`sameSite=strict` cookie issuance, CSRF wiring.
- **Runs parallel to** **`auth-jwt-agent`** (Wave 4) — disjoint folders, same interface.

### `rbac-embedded-agent`

- **Owns:** `rbac-strategies/embedded-claims/`.
- **Reads:** `PLAN.md` §3.3 (RBAC strategy A), `IAuthorizationProvider` from `CONTRACTS.md`.
- **Ships:** claims resolution at login/refresh, baked into token/session payload.

### `rbac-dblive-agent`

- **Owns:** `rbac-strategies/db-live/`.
- **Reads:** `PLAN.md` §3.3 (RBAC strategy B).
- **Ships:** live DB lookup, short-TTL Redis cache, `invalidate(userId)`.
- **Runs parallel to** **`rbac-embedded-agent`** (Wave 4, all four strategy agents run together).

### `guards-decorators-agent`

- **Owns:** `common/decorators/` (`@CurrentUser`, `@Roles`, `@Permissions`, `@Public`), `common/guards/` (`AuthGuard`, `RbacGuard`, `ThrottlerGuard`).
- **Reads:** `CONTRACTS.md` only — this agent should never need to open a strategy implementation file, which is the whole point of the interface layer.
- **Wave 5, solo** — depends on all four strategy agents existing (even as stubs from Wave 3 is enough to *start*, but final wiring needs their real output).

### `rbac-admin-api-agent`

- **Owns:** `modules/rbac-admin/` (controller + resolver + service), `database/seed/rbac.seed.json`, `database/seed/rbac.seed.ts`.
- **Reads:** `PLAN.md` §5, §9 (Phase 9).
- **Ships:** upsert seed flow, runtime role/permission CRUD, `is_system` deletion guard, calls `invalidate()` on mutation when `db-live` active.

### `graphql-parity-agent`

- **Owns:** `modules/auth/auth.resolver.ts`, resolver mirrors for every REST endpoint, query depth/complexity limits.
- **Reads:** `PLAN.md` §10, the DTOs `auth-jwt-agent`/`auth-session-agent` published.
- **Runs parallel to** **`rbac-admin-api-agent`** (Wave 6).

### `security-hardening-agent`

- **Owns:** helmet/CORS/CSRF bootstrap config, throttler tuning per-route, brute-force lockout counter.
- **Reads:** `PLAN.md` §8.
- **Wave 7, solo** — needs real routes to exist first (rate-limit which endpoints, CSRF on which cookie flow).

### `frontend-kit-agent`

- **Owns:** `rbac-core` publish config, `/auth/me`, `/authz/check` endpoints, example `usePermission()` React hook.
- **Reads:** `PLAN.md` §12.

### `test-agent`

- **Owns:** nothing production — only `*.spec.ts` / e2e specs.
- **Reads:** everything; runs last.
- **Ships:** unit tests for `rbac-core.can()` and each of the four strategy implementations in isolation, plus the e2e suite run twice (once per `AUTH_STRATEGY` value) per §11 Phase 13.
- **Runs parallel to** **`frontend-kit-agent`** (Wave 8, closing wave).

---

## 3. Wave schedule

```
Wave 1  scaffold-agent                                          (solo)
Wave 2  db-schema-agent          │ rbac-core-agent               (parallel)
Wave 3  strategy-interfaces-agent                                (solo — freezes CONTRACTS.md)
Wave 4  auth-jwt-agent │ auth-session-agent │ rbac-embedded-agent │ rbac-dblive-agent   (4-way parallel)
Wave 5  guards-decorators-agent                                  (solo)
Wave 6  rbac-admin-api-agent     │ graphql-parity-agent           (parallel)
Wave 7  security-hardening-agent                                 (solo)
Wave 8  frontend-kit-agent       │ test-agent                     (parallel, closing)

```

Waves 2, 4, 6, and 8 are where the multi-agent structure actually buys you time — four independent agents touching disjoint folders against a frozen contract. Waves 1, 3, 5, 7 are deliberately solo because they either bootstrap or freeze something everyone downstream depends on; parallelizing them would just create merge conflicts on shared files.

---

## 4. Why this split (not a different one)

- The split follows the plan's own boundary: **`rbac-core/`** **has no NestJS or DB imports** — that's already a hard architectural seam, so it gets its own agent that can run before the DB schema even exists.
- The four strategy implementations (`jwt-stateless`, `session-redis`, `embedded-claims`, `db-live`) are explicitly described in the plan as interchangeable and orthogonal — that's the natural 4-way parallel wave.
- `guards-decorators-agent` is deliberately kept ignorant of concrete strategies (reads only `CONTRACTS.md`) — this is the same "controllers never see which concrete strategy ran" guarantee from §6 of the plan, enforced at the agent-boundary level, not just the code level.
- `test-agent` running last and reading everything mirrors Phase 13 needing all four strategy combinations to exist first.

---

## 5. Conflict points to watch

- `app.module.ts` gets touched by `scaffold-agent` (create), then `db-schema-agent` and `strategy-interfaces-agent` (register modules) — the orchestrator should merge these by hand rather than letting two waves both edit it unsupervised.
- `.env` / `AppConfig` schema gets additions from `scaffold-agent`, `auth-session-agent` (Redis vars), and `security-hardening-agent` — same treatment.
- If `strategy-interfaces-agent`'s Wave 3 output changes an interface after Wave 4 has started, that's a sign the interface should have been frozen earlier — orchestrator should treat this as a stop-the-line event, not a silent patch.
