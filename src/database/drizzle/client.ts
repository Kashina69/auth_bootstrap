import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type DrizzleDb = NodePgDatabase<typeof schema>;

/**
 * The single entry point `DatabaseModule` uses when `DB_PROVIDER=drizzle`: one pool,
 * one schema-bound db handle, handed to every Drizzle repository constructor.
 */
export function createDrizzleClient(connectionString: string): DrizzleDb {
  return drizzle(new Pool({ connectionString }), { schema });
}
