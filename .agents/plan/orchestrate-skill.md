# orchestrate-skill.md — How to run this build with subagents

Distilled from Waves 1–6 of the auth+rbac build. Binding on the orchestrator (the main
chat). Workers never read this file — it tells the orchestrator how to *dispatch* them.

Companion docs: `plan.agent.md` (the wave schedule), `MEMORY.md` (build log + decisions),
`WAVE-LOG.md` (per-wave ledger: agents, tokens, gate, issues, security). This file is the
*process*; those are the *content*.

---

## 1. The one rule: an agent's cost ≈ its scope + a fixed orientation tax

Measured agent costs, Waves 5–6:

| Agent | Scope | Tokens | Tool calls |
|---|---|---|---|
| guards-decorators | 6 small files | 36.4k | 23 |
| auth-service | service + DTOs + password | 73.2k | 45 |
| auth-http | controller + module | 67.2k | 32 |
| rbac-admin | whole vertical + seed | 118.9k | 100 |
| contract-fix | 12 adapters + service + seed + tests | 118.2k | 123 |
| verifier (full-tree) | audit everything | 68.0k | 40 |
| verifier (diff-scoped) | audit one wave's diff | 59.8k | 28 |

Two conclusions:

- **Cost scales with scope, not with layer count.** Splitting one task into three agents does
  not divide its cost three ways — each agent re-pays the orientation tax (locating files,
  reading contracts) plus a share of the work. Merge small related work into one agent.
- **The orientation tax is real and reducible.** Agents burned 20–120 tool calls mostly
  *finding* things. Give exact paths and line ranges and it drops sharply.

## 2. Wave sizing — the biggest lever

- **One agent per genuinely independent deliverable**, where "independent" means *no shared
  file and no unfrozen interface between them*. Not per layer.
- **Never** split a single coherent change across agents to "parallelize" it — that creates
  interface guessing and rework. **Never** merge two independent verticals into one agent —
  that serializes them and bloats one context.
- **Prefer smaller waves.** Wave 6 cost 353k vs Wave 5's 292k *despite* using fewer agents,
  because its scope was larger and it needed a defect-fix round. The verify→fix cycle cost
  178k — half the wave. Scope discipline beats agent-count optimization.
- Rough guide: one agent ≈ 40–120k. Budget the wave before dispatching and say the number out
  loud so a runaway scope is visible early.

## 3. Pre-flight — orchestrator only, before ANY dispatch

Agents burn tokens discovering things the orchestrator can find in one command. Always:

1. **Resolve dependencies first.** Both waves, an agent hit a missing package
   (`@nestjs/graphql`, `argon2`, `@as-integrations/fastify`). Grep `package.json` for what the
   spec mandates before dispatching anything that needs it.
2. **Check peer compatibility.** `graphql@17` had to be walked back to `16.x` because
   `@apollo/server@5` peer-requires `^16`. Run `pnpm peers check` after any install.
3. **Verify every factual claim you are about to hand an agent.** See §9 — a misread grep sent
   a whole fix-round in the wrong direction.
4. **Boot the app before claiming a wave is done.** `pnpm build` + `pnpm test` passing does
   NOT prove DI resolves or a driver starts. A real `node dist/main.js` caught that the Apollo
   driver needed `@as-integrations/fastify` to boot at all.
5. **Freeze new interfaces yourself** (see §4) — workers must not edit `CONTRACTS.md`.

## 4. Interface freezing — what makes concurrency safe

Concurrency is only safe when every shared boundary is already frozen *and written into each
dispatch prompt*. Before dispatching parallel agents:

- Write the exact signatures they will share into `CONTRACTS.md` (with a change-log row), or
  inline them in the prompts if they are new and local.
- A worker **never** edits `CONTRACTS.md`. If a worker needs an interface change, it reports
  it; the orchestrator freezes it and dispatches the implementation.
- This is what let three Wave 5 agents run concurrently with zero collisions.

## 5. Dispatch rules — the prompt template

Every build-agent prompt contains, in this order:

1. **Role + repo root + "one of N agents running CONCURRENTLY"**.
2. **Owned paths — an explicit file list, and an explicit do-not-touch list.** Name the other
   agents' paths so they know what to avoid.
3. **Read ONLY these** — exact file + line ranges ("`implementation.spec.md` §5 (lines
   241–330)"). Never "read the plan folder". This is the single biggest token saver.
4. **Frozen signatures** they code against, copied in — so they never guess an interface.
5. **Environment constraints** that cause silent failure: ESM `.js` extensions, Fastify not
   Express, which packages are/aren't installed.
6. **The style contract inline** (STYLE.md mandates it, and inlining is cheaper than a read).
7. **Verification command**, explicitly `pnpm exec tsc --noEmit` — **never `pnpm build`** when
   agents run concurrently, since they would race on `dist/`.
8. **Report format: SHORT.** Ask for paths, the decisions made, and the exact command results.
   Do not invite essays; a report is not a deliverable.

## 6. Cheap integration — orchestrator, never an agent

Wiring a module into `app.module.ts` is 2–3 lines. As an agent in Wave 5 that cost **47k** and
duplicated a `@Global()` check another agent had already run. Do it yourself.

Rule: **if it is under ~10 lines and needs no exploration, the orchestrator does it.** Reserve
agents for work that needs reading, writing, and iterating.

## 7. The gate — orchestrator runs it

Run all of these yourself; they cost almost nothing in tokens versus an agent doing it:

```
pnpm build                              # exit 0
pnpm test                               # exact file/test counts, must not decrease
pnpm exec tsc --noEmit -p tsconfig.json # exit 0 — NOT optional, see §8
pnpm exec oxlint src/ test/             # exit 0
node dist/main.js                       # boots, routes mapped, no throw
# THEN execute real requests against the running app and assert on the responses.
```

**The boot check must be followed by real requests.** A boot proves DI resolves; it does not
prove anything *works*. Wave 7 found three separate crashes — in a global interceptor, the
exception filter, and the throttler guard — that every one of `build`, `test`, `tsc`, `oxlint`,
a clean boot, and an adversarial code-reading verifier had all passed. They were only visible
by executing a real resolver against the running app.

**`tsc --noEmit` is mandatory and was nearly missed twice.** `pnpm build` uses
`tsconfig.build.json` which *excludes specs*, and vitest transpiles without typechecking — so
three latent type errors accumulated invisibly across Waves 4–5, including a fake repository
missing a method added that same wave. Build+test green is **not** a sufficient gate.

`git status --short` too: confirm no agent wrote outside its owned paths.

## 8. Verification — two tiers, cheapest sufficient

Both waves, independent verification found real defects the workers' own tests called correct.
Never skip it; never pay more for it than needed.

- **Tier 0 — orchestrator spot-checks.** For any specific claim ("X was fixed", "Y is unused"),
  a `grep`/`sed` costs ~nothing. Do this first; it resolves most claims. **Check the claim
  against the actual artifact, including which entity it belongs to** (§9).
- **Tier 1 — one adversarial verifier, scoped to the diff.** `git diff HEAD` + the wave's new
  files, not the whole tree. Note honestly: diff-scoping a wave that is *mostly new files*
  barely saves anything (59.8k vs 68k) — it wins only on incremental waves.
- The verifier prompt must: forbid edits; forbid `git` writes; mark what the orchestrator
  already verified so it is not re-done; demand `file:line` + the spec line violated for every
  FAIL; and **distinguish a real defect from a contract gap** (blocked by a frozen interface is
  an escalation, not a bug — several agents were correctly blocked, not negligent).
- Ask explicitly for the class of defect tests miss: *does any comment claim something the
  code does not do?* That is how the `isSystem` defect surfaced — a comment asserted a false
  baseline rule and a test encoded the bug as passing.

## 9. Never trust a grep without checking what it matched

The orchestrator grepped `is_system|isSystem`, saw three hits, and concluded the column existed
for `permissions` — **all three were on `roles`**. That wrong claim went into the plan docs and
to the user, and sent a fix-round toward "just expose the field" when a real `ALTER TABLE` was
needed. The agent caught it; the orchestrator should have.

**Before asserting a fact: open the artifact and confirm which entity, table, or class it
belongs to.** Cheap check, expensive mistake.

### 9a. Confirm the *test* measured what you think it measured

Two false alarms in one session, both from checks that could not have shown what was claimed:

- **Introspection queries bypass `graphql-depth-limit`.** A deep `__schema` query returned 200,
  which was read as "the depth limit is broken". It was not — the identical query shape with a
  non-introspection root *was* correctly flagged. The probe was incapable of detecting either
  outcome.
- **A hand-built execution context is not the real one.** `git`-free unit probes passed while
  the live HTTP path crashed.

Before calling something a defect, ask: *if this were working perfectly, would my check print
the same thing?* If yes, the check is worthless. Prefer a check where pass and fail look
different, and prefer the real path over a synthetic one.

### 9b. `git checkout -- <file>` is not a revert for uncommitted work

It restores from **HEAD**. If the file has uncommitted wave work, that work is destroyed — and
if HEAD predates the wave, it looks like the agent "never did it". This cost one wave 62k to
undo. To back out a temporary probe: `cp` the file to a scratch path first, then `cp` it back.
Reserve `git checkout --` for reverting work that is already committed.

## 10. Mutation-check security assertions

A passing test proves nothing about *what* it pins. For any security-critical guard, force the
condition false and confirm the test **fails**, then restore. The `isSystem` fix was verified
exactly this way: stubbing the guard to `if (false)` failed precisely the two baseline tests.
Ask the agent to report the mutation check as evidence, not just "tests pass".

## 11. Keep the ledger — every wave, without exception

Update `WAVE-LOG.md` at the end of every wave: per-agent token cost, tool calls, duration; the
gate results verbatim; defects found and their disposition; security-relevant findings; open
items. This is what makes an eventual external validation pass possible without re-scanning
`src/`. Do not renumber or rewrite history — append and correct in place, marking corrections.

## 12. Anti-patterns observed (all real, all costly)

| Anti-pattern | What it cost |
|---|---|
| Integration agent re-verifying what another agent already checked | 47k |
| Deferring dependency discovery to the worker | agent thrashing, rework |
| Letting a spec encode a bug as a passing test | defect shipped past a green gate |
| Full-tree verifier on an incremental wave | 68k where ~60k scoped would do |
| `build`+`test` green treated as sufficient gate | 3 latent type errors, 2 waves |
| Asserting a fact from a grep without checking the entity | a whole fix-round aimed wrong |
| Oversized wave | Wave 6 at 353k vs Wave 5's 292k |
| Trusting a synthetic probe as proof of the real path | 2 false alarms; one fix destroyed |
| `git checkout --` on a file holding uncommitted wave work | 62k to re-apply |
| Registering a global guard/interceptor without checking non-HTTP contexts | 3 runtime crashes invisible to the entire gate |

### 12a. Adding a global enhancer requires a GraphQL check

Wave 7's three defects were one root cause: **the codebase assumes every request is HTTP.**
Interceptors, exception filters and guards registered globally in `main.ts` / `app.module.ts`
all ran for GraphQL resolvers too, where `switchToHttp()` yields no request. Guards written in
Wave 5 handled this (`getRequest` branches on `context.getType<'graphql'>()`); everything
written before GraphQL was *reachable* did not — so the defects stayed latent until Wave 6
turned GraphQL on, then surfaced one at a time as each fix unmasked the next.

**Rule:** any provider registered globally (`APP_GUARD`, `APP_INTERCEPTOR`, `APP_FILTER`, or
`app.useGlobal*`) must be checked for non-HTTP context support at the moment it is added.
Prefer solutions that keep the protection applied to both transports — a guard that simply
*skips* non-HTTP contexts silently removes that protection from the GraphQL surface, which for
`login`/`register`/`refresh` (exposed as both REST and GraphQL) is a brute-force bypass, not a
convenience.

## 13. Standing rule

The orchestrator owns: pre-flight, interface freezing, wiring under ~10 lines, the gate,
tier-0 spot-checks, the ledger, and all commits. Agents own: discovering, writing, and
iterating on real work inside explicitly owned paths. **Anything the orchestrator can verify in
one command, the orchestrator verifies** — an agent doing it is pure waste.
