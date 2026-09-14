import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Raw Postgres access for the three SQL adapters. Migrations, truncation and the
 * hash-at-rest read all bypass the ORM on purpose: a repository cannot be asked to
 * report what it *should* have hidden, and the schema has to exist before any of them run.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'src/database/migrations');

const ALL_TABLES =
  'refresh_tokens, user_roles, role_permissions, users, roles, permissions';

/** Every migration directory in filename order — the DDL source of truth, `migration_lock.toml` excluded. */
function migrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
}

export interface PostgresAdmin {
  /** Drops `public` and replays every migration, so a run never inherits a stale schema. */
  migrate(): Promise<void>;
  truncate(): Promise<void>;
  softDeleteUser(id: string): Promise<void>;
  /** The whole `refresh_tokens` table as text — what is physically on disk, not what a finder returns. */
  dumpRefreshTokens(): Promise<string>;
  close(): Promise<void>;
}

export async function createPostgresAdmin(connectionString: string): Promise<PostgresAdmin> {
  const client = new Client({ connectionString });
  await client.connect();

  return {
    async migrate(): Promise<void> {
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
      for (const migration of migrations()) await client.query(migration);
    },
    async truncate(): Promise<void> {
      await client.query(`TRUNCATE TABLE ${ALL_TABLES} CASCADE`);
    },
    async softDeleteUser(id: string): Promise<void> {
      await client.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [id]);
    },
    async dumpRefreshTokens(): Promise<string> {
      const result = await client.query('SELECT * FROM refresh_tokens');
      return JSON.stringify(result.rows);
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}

/**
 * There is deliberately no schema-alignment step here any more.
 *
 * The three SQL adapters used to be verified against the migrations *plus* a patch that
 * reconciled two divergences (missing column defaults; `TIMESTAMP(3)` vs `timestamptz`),
 * which meant the contract held only for a schema production did not have. Both are now
 * fixed in a real migration — `20260914000001_timestamptz_and_column_defaults` — so the DDL
 * replayed above is the DDL that ships, and a future divergence fails the suite rather than
 * being patched away at test time (WAVE-LOG.md S17/S18).
 */
