# orchestrate-skill.md — How to run this build with subagents

Distilled from Waves 1–8 of the auth+rbac build. Binding on the orchestrator (the main
chat). Workers never read this file — it tells the orchestrator how to *dispatch* them.

**Read §2 before anything else.** It is the dispatch decision: whether to spawn an agent at all
(§2a), how wide to scope it (§2b), and how to make parallel work safe (§2c). Everything after it
is detail on executing a decision §2 already made. The short version: **fewer agents, each
owning more, in smaller waves** — and often none at all.

Companion docs: `plan.agent.md` (the wave schedule), `MEMORY.md` (build log + decisions),
`WAVE-LOG.md` (per-wave ledger: agents, tokens, gate, issues, security). This file is the
*process*; those are the *content*.

**Porting to another backend framework?** Read `PORT-EXPRESS.md` (NestJS + Express — a small
adapter swap) or `PORT-FRAMEWORK.md` (leaving NestJS entirely — Hono, Next.js, Elysia…). Both
define their own wave plans, owned paths and acceptance gates, and both defer to this file for
dispatch mechanics, so everything in §4–§8 still applies.

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

Three conclusions:

- **Cost ≈ scope + a fixed orientation tax.** Splitting one task into three agents does not
  divide its cost three ways — each agent re-pays the orientation tax (locating files, reading
  contracts) on top of its share of the work. Merging small related work into one agent is
  almost always cheaper than splitting it.
- **The orientation tax is real and reducible.** Agents burned 20–120 tool calls mostly
  *finding* things. Exact paths and line ranges cut it sharply (§6).
- **Hallucination is what you buy when you under-pay the orientation tax.** An agent that cannot
  find an interface **guesses** it. Guessed interfaces are the largest single source of rework in
  this project's history. The fix is never "a better agent" — it is copying the frozen signature
  into the prompt and narrowing the read list, so there is nothing left to guess.

## 2. Granularity — one agent per SECTION, never per file

The unit of dispatch is a **section**: a vertically cohesive deliverable an agent can own
end-to-end — one module's whole test suite, one API vertical, all implementations of one
interface. Not a file, not a layer, not an endpoint.

**Measured, from this project's own planning.** The test plan's first draft proposed **four
agents for four ORM adapters**. Those four adapters share *one* contract test. Four agents would
each re-read `CONTRACTS.md` §5, re-learn the harness and re-locate the adapters — four
orientation taxes for work that is mechanically identical. One agent writes all four specs for
barely more than the cost of one. The rule that produced:

| Do | Don't |
|---|---|
| one agent owns a whole module's tests | one agent per test file |
| one agent owns a whole API vertical | one agent per endpoint |
| one agent owns **all N** implementations of one interface | one agent per implementation |
| one agent owns all remaining gaps in a subsystem | one agent per untested file |

**Two rules that look contradictory and are not:**

- **Fewer, larger agents per wave** (§2a) — slice the wave by *section*.
- **Smaller waves overall** (§2b) — keep each wave's *total scope* moderate.

Both hold. Wave 6 cost 353k vs Wave 5's 292k *despite* using fewer agents, because the wave's
total scope was larger and it needed a defect-fix round (verify→fix alone was 178k — half the
wave). Scope and granularity are separate dials: turn total scope **down**, turn per-agent scope
**up**.

### 2a. The dispatch decision — run this before creating any agent

Ask in order; the first "yes" wins.

1. **Can I name every file I will edit, right now?** → **do it inline. Dispatch nobody.** You
   already hold the context; an agent pays the orientation tax to re-derive it, and you pay a
   hand-off seam on top. Wave 8 (two endpoints, one hook, three specs, one e2e suite) was built
   this way for **0 agent tokens**, against 292–353k for the waves before it.
2. **Will two workstreams edit the same file?** → that file is **orchestrator work in a Wave 0**
   (§2c); then the workstreams run in parallel without it.
3. **Is it under ~10 lines and needing no exploration?** → orchestrator (§7).
4. **Otherwise** → **one agent per section**, dispatched in parallel with the others.

Honest caveat on (1): it applies only if you have *already* paid to load that context. Starting
cold would mean reading ten files to begin, and then an agent's orientation tax is buying you
something real. The test is "can I name the files", not "does this feel small".

### 2b. Sizing, and the concurrency ceiling

- **Target 40–120k per agent.** Budget the wave before dispatching, and say the number out loud
  so a runaway scope is visible early rather than at the end.
- **A section agent past ~150k has left its section.** Stop it and re-scope. **Do not subdivide
  it into more agents** — that multiplies the orientation tax you were trying to avoid.
  Re-scoping means "smaller deliverable", never "more workers".
- **Four to five concurrent agents is the practical ceiling.** Past that, merge-and-verify cost
  grows faster than wall-clock falls, and the odds that two agents unknowingly share a file
  approach one.
- **Parallelism only pays for genuinely independent sections.** The wall-clock floor is the
  longest single section — adding agents that must be serialized afterwards buys nothing.
- **Wall clock is not the only axis.** Do not parallelize to look fast. A wave that finishes in
  20 minutes with two agents is better than one that finishes in 12 with five and needs a merge
  repair — the repair is unplanned, and it is where the security regressions live.

### 2c. What makes parallelism safe — clear the shared boundaries first

Parallel agents are safe only when **no two can write the same byte**. Before dispatching any
concurrent wave, the orchestrator runs a **Wave 0** that clears every shared boundary:

- **Manifests and config** — `package.json`, lockfiles, tsconfig, vitest/lint configs, `.env`
  samples. If two agents both need a new script or config entry, **neither** writes it.
- **Shared test harnesses and fixtures** — one agent's helper is another's dependency. Freeze it
  before dispatch and mark it **do-not-touch**; an agent needing a change **reports** it.
- **Interfaces** — frozen and copied into every prompt (§4, §5).
- **Entry points** — `main.ts`, `app.module.ts`, composition roots. Usually small enough to be
  orchestrator work regardless (§7).

Then, per agent: an explicit **owned-path list**, and an explicit **do-not-touch list that names
the other agents' paths**. An agent that does not know what its neighbours own will wander into
them.

**If you cannot clear the shared boundaries, the wave is not ready to parallelize.** Run it
sequentially — slower, but recoverable. A merge conflict between two agents is neither.

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

§2c is the general rule (clear **every** shared boundary, including manifests and harnesses).
This section is the part that specifically concerns *interfaces*: concurrency is only safe when
every shared boundary is already frozen *and written into each dispatch prompt*. Before
dispatching parallel agents:

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

### 6a. Sometimes dispatch no agent at all — Wave 8's rule

See **§2a**, which is the canonical form of this rule. Short version: if you can name every file
you will edit right now, dispatch nobody — Wave 8 (two endpoints, one hook, three spec files, one
e2e suite) was built entirely inline for **0 agent tokens**. The test is "can I name the files",
not "does this feel small".

## 7. The gate — orchestrator runs it

Run all of these yourself; they cost almost nothing in tokens versus an agent doing it:

```
pnpm build                              # exit 0
pnpm test                               # exact file/test counts, must not decrease
pnpm test:e2e                           # exit 0 — the per-AUTH_STRATEGY suite (Wave 8)
pnpm exec tsc --noEmit -p tsconfig.json # exit 0 — NOT optional, see §8
pnpm exec oxlint src/ test/             # exit 0
node dist/main.js                       # boots, routes mapped, no throw
# THEN execute real requests against the running app and assert on the responses.
```

`tsc --noEmit` and the live-probe step are both load-bearing; the e2e suite is a *third*,
weaker net — it substitutes the persistence boundary, so it proves the wiring and the HTTP
surface, not the real drivers. Do not let a green e2e stand in for the boot + probe step.

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
| **One agent per file / per implementation of one interface** | N × the orientation tax for work that was mechanically identical (§2). Caught in the test plan's first draft before it was run |
| **Parallelizing without clearing shared files first** | merge conflicts between agents, or silent overwrites — the class of repair that introduces security regressions. See §2c |
| Integration agent re-verifying what another agent already checked | 47k |
| Deferring dependency discovery to the worker | agent thrashing, rework |
| Letting a spec encode a bug as a passing test | defect shipped past a green gate |
| Full-tree verifier on an incremental wave | 68k where ~60k scoped would do |
| `build`+`test` green treated as sufficient gate | 3 latent type errors, 2 waves |
| Asserting a fact from a grep without checking the entity | a whole fix-round aimed wrong |
| Oversized wave | Wave 6 at 353k vs Wave 5's 292k |
| Subdividing an over-budget agent into more agents | multiplies the tax you were avoiding; re-scope the deliverable instead (§2b) |
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

The orchestrator owns: pre-flight, interface freezing, clearing shared boundaries (§2c), wiring
under ~10 lines, the gate, tier-0 spot-checks, the ledger, and all commits. Agents own:
discovering, writing and iterating on real work inside explicitly owned paths. **Anything the
orchestrator can verify in one command, the orchestrator verifies** — an agent doing it is pure
waste.

**The default is fewer agents than you think.** Every dispatch decision runs through §2a first.
The failure mode of a capable orchestrator is not laziness — it is dispatching reflexively,
because spawning an agent *feels* like progress. It usually is not: it converts context you
already hold into a hand-off seam, and pays an orientation tax to get back to where you started.
When in doubt, do it yourself; when it genuinely spans unfamiliar ground, send **one** agent and
scope it **wide** rather than three agents scoped narrow.

**The three dials, in priority order:**

| Dial | Turn it | Why |
|---|---|---|
| **Total wave scope** | **down** | the dominant cost lever (§2b) |
| **Per-agent scope** | **up** | fewer orientation taxes (§2) |
| **Agent count** | **only as high as independent sections** | parallelism ≠ savings (§2b) |

Fewer agents, each owning more, in smaller waves. That is the whole mentality.
