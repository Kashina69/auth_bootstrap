# MEMORY.md — Running Build Log

Updated by the orchestrator after each wave (never by workers — avoids write races).

## Decisions locked at kickoff (2026-09-11)

- **Scope:** full 8-wave build (all 4 strategies, Redis, GraphQL, rbac-admin, hardening,
  tests).
- **ORM surface:** Prisma + Drizzle + Sequelize + **Mongoose**. Note: Mongoose (MongoDB)
  replaces the plan's TypeORM. The source-of-truth schema is relational (PostgreSQL);
  the Mongoose adapter implements the same repository contracts against Mongo
  collections — a document-model adapter, not a schema change. Cross-check: `plan.md` §4
  uses `citext`/`jsonb`/FK joins that have no direct Mongo equivalent; adapter must
  normalize to the same repository interface + `null`-on-not-found.
- **Defaults (§12):** `AUTH_STRATEGY=jwt-stateless` + `RBAC_STRATEGY=embedded-claims`;
  db-live cache TTL 5–10s; ABAC-lite (`role_permission_conditions`) deferred to v1.1.
- **Orchestration:** multi-agent wave schedule per `plan.agent.md` §3.

## Waves

| Wave | Agents | Status |
|------|--------|--------|
| 1 | scaffold-agent | ✅ done (2026-09-11) |
| 2 | db-schema-agent ∥ rbac-core-agent ∥ orm-adapters-agent | in progress |
| 3 | strategy-interfaces-agent | pending |
| 4 | auth-jwt-agent ∥ auth-session-agent ∥ rbac-embedded-agent ∥ rbac-dblive-agent | pending |
| 5 | guards-decorators-agent | pending |
| 6 | rbac-admin-api-agent ∥ graphql-parity-agent | pending |
| 7 | security-hardening-agent | pending |
| 8 | frontend-kit-agent ∥ test-agent | pending |

## Deviations / notes

(none yet)
