# Mongoose adapter — relational schema mapped onto MongoDB

The source-of-truth schema (`plan.md` §4) is relational PostgreSQL. This adapter
implements the **same** repository contracts (`CONTRACTS.md` §5) over MongoDB, so
`DB_PROVIDER=mongoose` swaps the storage engine without any service, guard, strategy or
controller changing. Only `database/database.module.ts` picks the implementation.

## Collection mapping

| Postgres (plan.md §4)                  | MongoDB                                                              |
| -------------------------------------- | -------------------------------------------------------------------- |
| `users`                                | `users` collection                                                   |
| `roles`                                | `roles` collection                                                   |
| `permissions`                          | `permissions` collection                                             |
| `refresh_tokens`                       | `refresh_tokens` collection                                          |
| `user_roles` (join)                    | `users.roleIds: ObjectId[]` — embedded                               |
| `role_permissions` (join)              | `roles.permissionIds: ObjectId[]` — embedded                         |
| `email citext unique`                  | `email` normalized to lowercase in the schema + a unique index on it |
| `uuid` primary keys                    | `ObjectId` `_id`                                                     |
| FK `ON DELETE CASCADE`                 | explicit cleanup in application code (see below)                     |
| `jsonb` (`role_permission_conditions`) | out of scope at v1 — deferred per `MEMORY.md` kickoff                |

## Trade-offs this mapping accepts

- **Joins become app-side aggregation.** `findRolesAndPermissions` is three fixed
  queries (user → its roles → those roles' permissions) rather than one SQL join with
  two left joins as in the Drizzle adapter. The number of round trips is constant, not
  N+1, but it is still more work than the relational adapters' single query. The same is
  true of `RoleRepository.listPermissions`.
- **No referential integrity.** MongoDB enforces no foreign keys, so
  `RoleRepository.delete` and `PermissionRepository.delete` explicitly `$pull` the
  deleted id out of every referencing document — the job the Postgres FKs do for free.
  A crash between the two writes leaves a dangling id behind; the relational adapters
  cannot reach that state at all.
- **Join-table metadata is dropped.** `user_roles.assigned_by` / `assigned_at` have no
  home in an embedded `roleIds` array. Nothing in the frozen repository contracts reads
  them, so they are omitted rather than modelled as an object array. Re-adding them
  later means changing the embedded shape to `{ roleId, assignedBy, assignedAt }[]`.
- **Atomicity.** Embedding makes "attach permissions to a role" a single-document
  `$addToSet`, which is atomic — but `UserRepository.create` followed by a default-role
  assignment is two documents and therefore not transactional. The Postgres adapters
  get the same property only inside an explicit transaction; nothing in the current
  flow relies on it.
- **`citext` is emulated, not reproduced.** The schema lowercases `email` on write and
  `findByEmail` lowercases the query, but a document written by anything other than this
  adapter (a manual `mongo` shell insert, say) bypasses that normalization. The
  case-insensitive unique index is therefore only as good as the write path.
- **`createdAt`/`updatedAt`** come from Mongoose `timestamps` rather than the explicit
  `created_at`/`updated_at` columns; `permissions` and `refresh_tokens` set
  `updatedAt: false` to match the source schema, which has no such column.

## Files

- `connection.ts` — `createMongooseClient(uri)`: the one entry point `DatabaseModule`
  calls; returns the `Connection` with all four models registered on it.
- `schemas/*.schema.ts` — the per-collection Mongoose schemas and their document types.
- The repositories themselves live in `database/repositories/mongoose-*.repository.ts`.

## Migrations

Unchanged in spirit from the other adapters: Mongoose's index definitions are created by
`syncIndexes()`/`autoIndex` at runtime, and MongoDB's schema is flexible — there is no
migration tool unified with Prisma/Drizzle/Sequelize here. Switching `DB_PROVIDER` to
`mongoose` against a database that already holds relational data requires a one-off
data migration, not just a config change.
