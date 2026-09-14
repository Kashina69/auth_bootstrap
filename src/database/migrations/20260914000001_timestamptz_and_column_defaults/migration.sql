-- Reconciles the migrated schema with what the four ORM adapters declare, so that all of
-- them — not three of them plus a test-time patch — work against the schema production
-- actually ships. Found by the adapter contract suite (WAVE-LOG.md items S17/S18).
--
-- Two changes, both DB-side on purpose: a database that supplies its own ids and timestamps
-- is inert for Prisma and Sequelize (which fill those client-side anyway), while a database
-- that does not is a hard failure for Drizzle, which emits `DEFAULT` for both.

-- 1. Column defaults. `20260911000000_init` omits them on every `id` and on
--    `users.updated_at` / `roles.updated_at`. `DEFAULT` against a column with no default is
--    NULL, so every Drizzle insert died on `null value in column "id" violates not-null
--    constraint` — 22 of its 27 contract tests. `gen_random_uuid()` is built in from PG 13.
ALTER TABLE "users"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "roles"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "permissions"    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "refresh_tokens" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "roles" ALTER COLUMN "updated_at" SET DEFAULT now();

-- 2. Timestamps become `timestamptz`. `drizzle/schema.ts` declares `withTimezone: true` and
--    Sequelize maps `DataTypes.DATE` to `timestamptz`, so the migration was the odd one out
--    — and it was the wrong one. `timestamptz` is what Postgres and Prisma both recommend,
--    and the zoneless column was not merely inconsistent: node-pg parses a zoneless
--    timestamp as *local* time, so on any non-UTC host the same instant round-tripped
--    shifted through Drizzle and Sequelize while Prisma read it as UTC.
--
--    `AT TIME ZONE 'UTC'` states the assumption the old data was written under: every
--    existing value came from Prisma or node, both of which send UTC wall-clock.
ALTER TABLE "users"          ALTER COLUMN "created_at"  TYPE TIMESTAMPTZ(3) USING "created_at"  AT TIME ZONE 'UTC';
ALTER TABLE "users"          ALTER COLUMN "updated_at"  TYPE TIMESTAMPTZ(3) USING "updated_at"  AT TIME ZONE 'UTC';
ALTER TABLE "users"          ALTER COLUMN "deleted_at"  TYPE TIMESTAMPTZ(3) USING "deleted_at"  AT TIME ZONE 'UTC';
ALTER TABLE "roles"          ALTER COLUMN "created_at"  TYPE TIMESTAMPTZ(3) USING "created_at"  AT TIME ZONE 'UTC';
ALTER TABLE "roles"          ALTER COLUMN "updated_at"  TYPE TIMESTAMPTZ(3) USING "updated_at"  AT TIME ZONE 'UTC';
ALTER TABLE "permissions"    ALTER COLUMN "created_at"  TYPE TIMESTAMPTZ(3) USING "created_at"  AT TIME ZONE 'UTC';
ALTER TABLE "user_roles"     ALTER COLUMN "assigned_at" TYPE TIMESTAMPTZ(3) USING "assigned_at" AT TIME ZONE 'UTC';
ALTER TABLE "refresh_tokens" ALTER COLUMN "expires_at"  TYPE TIMESTAMPTZ(3) USING "expires_at"  AT TIME ZONE 'UTC';
ALTER TABLE "refresh_tokens" ALTER COLUMN "revoked_at"  TYPE TIMESTAMPTZ(3) USING "revoked_at"  AT TIME ZONE 'UTC';
ALTER TABLE "refresh_tokens" ALTER COLUMN "created_at"  TYPE TIMESTAMPTZ(3) USING "created_at"  AT TIME ZONE 'UTC';
