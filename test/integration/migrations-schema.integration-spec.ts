import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrl, migrateDatabase, truncateAll } from './support/live-services.js';

/**
 * The migrations are raw SQL applied by hand (setup.md §3), so nothing else in the suite would
 * notice if a migration stopped matching `schema.prisma`.
 *
 * **Scope, precisely:** `SCHEMA_COLUMNS` / `UNIQUE_KEYS` below are a hand-written transcription
 * of what `schema.prisma` declares — this spec does not parse `schema.prisma`. So it catches
 * **migration-side drift only**: a column the migration fails to create, or a unique constraint
 * it fails to add, is caught; a column newly added to `schema.prisma` is **not**, because the
 * transcription would have to be updated by hand for the check to notice. Making it read
 * `schema.prisma` directly is open work — until then this is a migration assertion, not a
 * schema-parity proof.
 */

/** Columns `src/database/prisma/schema.prisma` declares, per `@@map`-ed table. */
const SCHEMA_COLUMNS: Record<string, string[]> = {
  users: ['id', 'email', 'password_hash', 'is_active', 'is_email_verified', 'created_at', 'updated_at', 'deleted_at'],
  roles: ['id', 'name', 'description', 'is_system', 'created_at', 'updated_at'],
  permissions: ['id', 'action', 'subject', 'name', 'description', 'is_system', 'created_at'],
  role_permissions: ['role_id', 'permission_id'],
  user_roles: ['user_id', 'role_id', 'assigned_by', 'assigned_at'],
  refresh_tokens: ['id', 'user_id', 'token_hash', 'family_id', 'user_agent', 'ip', 'expires_at', 'revoked_at', 'created_at'],
};

/** Every `@unique` / `@@unique` in the schema, as the column set the DB must enforce. */
const UNIQUE_KEYS: Array<{ table: string; columns: string[] }> = [
  { table: 'users', columns: ['email'] },
  { table: 'roles', columns: ['name'] },
  { table: 'permissions', columns: ['name'] },
  { table: 'permissions', columns: ['action', 'subject'] },
  { table: 'refresh_tokens', columns: ['token_hash'] },
];

/** Prisma reports a raw-query failure as P2010 and passes the driver's SQLSTATE through. */
const UNIQUE_VIOLATION = /23505/;

describe('migrations produce the schema the ORM definitions describe', () => {
  let prisma: PrismaClient;
  let admin: Client;

  beforeAll(async () => {
    await migrateDatabase();
    prisma = new PrismaClient({ datasourceUrl: databaseUrl() });
    admin = new Client({ connectionString: databaseUrl() });
    await admin.connect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await admin.end();
    await prisma.$disconnect();
  });

  async function columnsOf(table: string): Promise<string[]> {
    const { rows } = await admin.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', table],
    );
    return rows.map((row) => row.column_name).sort();
  }

  /**
   * `pg_index` rather than `information_schema`: the migration emits `CREATE UNIQUE INDEX`,
   * which is a real constraint but is not reported as a table constraint.
   */
  async function uniqueIndexes(): Promise<Array<{ table: string; columns: string[] }>> {
    const { rows } = await admin.query<{ table_name: string; columns: string }>(
      `SELECT t.relname AS table_name,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                WHERE k.attnum > 0) AS columns
         FROM pg_index i
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE i.indisunique AND n.nspname = 'public'`,
    );
    return rows.map((row) => ({ table: row.table_name, columns: row.columns.split(',') }));
  }

  it('creates every table the schema declares, with every declared column', async () => {
    for (const [table, expected] of Object.entries(SCHEMA_COLUMNS)) {
      expect(await columnsOf(table), `${table} columns`).toEqual([...expected].sort());
    }
  });

  it('enforces every unique key the schema declares', async () => {
    const indexes = await uniqueIndexes();
    for (const key of UNIQUE_KEYS) {
      const wanted = [...key.columns].sort().join(',');
      const match = indexes.find(
        (index) => index.table === key.table && [...index.columns].sort().join(',') === wanted,
      );
      expect(match, `unique ${key.table}(${key.columns.join(', ')})`).toBeDefined();
    }
  });

  it('applies the is_system migration: NOT NULL, defaulting to false', async () => {
    const { rows } = await admin.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'permissions' AND column_name = 'is_system'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].column_default).toBe('false');
  });

  it('rejects a second account on the same email — the unique-email constraint is real', async () => {
    const email = 'unique@example.com';
    await insertUser(email);

    await expect(insertUser(email)).rejects.toThrow(UNIQUE_VIOLATION);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('keeps the address reserved after a soft delete — the unique index is unconditional', async () => {
    // `users.email` is unique regardless of `deleted_at`, so a soft-deleted row still holds its
    // address. Pinned because it is why re-registering a deleted account fails.
    const email = 'recycled@example.com';
    await insertUser(email);
    await prisma.user.update({ where: { email }, data: { deletedAt: new Date() } });

    await expect(insertUser(email)).rejects.toThrow(UNIQUE_VIOLATION);
  });

  it('round-trips against the Prisma client it was generated from', async () => {
    const { id } = await prisma.user.create({ data: { email: 'orm@example.com', passwordHash: 'x' } });

    const found = await prisma.user.findUnique({ where: { id } });
    expect(found).toMatchObject({ email: 'orm@example.com', isActive: true, isEmailVerified: false, deletedAt: null });
  });

  async function insertUser(email: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      'INSERT INTO users (id, email, password_hash, updated_at) VALUES ($1::uuid, $2, $3, now())',
      randomUUID(),
      email,
      'x',
    );
  }
});
