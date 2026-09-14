/**
 * `pnpm seed:rbac` — plan.md §5.
 *
 * Idempotent by construction: every write is a lookup-then-create over the same
 * `"action:subject"` identity the runtime API uses, and `RoleRepository.attachPermissions`
 * is additive, so re-running merges the baseline into whatever the database already holds
 * and leaves custom roles and grants untouched (§5.3). Nothing here talks to an ORM — the
 * repositories are resolved from `DatabaseModule` exactly as a service would resolve them.
 */
import { readFileSync } from 'node:fs';
import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PERMISSION_REPOSITORY, ROLE_REPOSITORY } from '../../common/constants.js';
import { AppConfig } from '../../config/app-config.service.js';
import { validateEnv, type Env } from '../../config/env.schema.js';
import { DatabaseModule } from '../database.module.js';
import type { Permission, PermissionRepository } from '../repositories/permission.repository.js';
import type { Role, RoleRepository } from '../repositories/role.repository.js';

interface SeedPermission {
  action: string;
  subject: string;
}

interface SeedRole {
  name: string;
  isSystem: boolean;
  permissions: string[];
}

interface SeedFile {
  permissions: SeedPermission[];
  roles: SeedRole[];
}

const logger = new Logger('RbacSeed');

/**
 * The seed runs under `tsx`, whose esbuild transform emits no decorator metadata, so
 * `AppConfig` cannot be injected by type the way the app injects it. An explicit factory
 * over the same validated config closes that gap, `DatabaseModule`'s repository factories
 * resolve exactly as they do at boot, and an invalid environment still refuses to connect
 * (CONTRACTS.md §9).
 */
const AppConfigProvider: Provider = {
  provide: AppConfig,
  useFactory: (config: ConfigService<Env, true>) => new AppConfig(config),
  inject: [ConfigService],
};

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })],
  providers: [AppConfigProvider],
  exports: [AppConfig],
})
class SeedConfigModule {}

/** `@Global()` modules are only global once something imports them. */
@Module({ imports: [SeedConfigModule, DatabaseModule.register()] })
class SeedModule {}

async function runSeed(permissions: PermissionRepository, roles: RoleRepository): Promise<void> {
  const baseline = loadBaseline();
  const baselineNames = baselinePermissionNames(baseline);
  const known = await upsertPermissions(permissions, baseline.permissions, baselineNames);
  await upsertRoles(roles, permissions, baseline.roles, known, baselineNames);
  logger.log(`baseline ready: ${known.size} permissions, ${baseline.roles.length} roles`);
}

/**
 * `is_system` marks what the runtime admin API may not delete (plan.md §5.4), so it is the
 * union of the two things the JSON calls baseline: the declared `permissions[]` list, and
 * every name a system role is granted. The second half matters because a role may grant a
 * permission the list forgot to declare — `admin` and `manage:Post` — and a grant the
 * baseline depends on is baseline in substance, not just in the list.
 */
function baselinePermissionNames(baseline: SeedFile): Set<string> {
  const declared = baseline.permissions.map((permission) =>
    permissionName(permission.action, permission.subject),
  );
  const grantedBySystemRoles = baseline.roles
    .filter((role) => role.isSystem)
    .flatMap((role) => role.permissions);
  return new Set([...declared, ...grantedBySystemRoles]);
}

/**
 * Every permission the baseline names is upserted before any role is touched, so a role
 * can never be granted an id that the run failed to persist.
 */
async function upsertPermissions(
  repo: PermissionRepository,
  seeds: SeedPermission[],
  baseline: Set<string>,
): Promise<Map<string, Permission>> {
  const known = new Map<string, Permission>();
  for (const seed of seeds) await rememberPermission(repo, known, seed.action, seed.subject, baseline);
  return known;
}

async function findOrCreatePermission(
  repo: PermissionRepository,
  action: string,
  subject: string,
  isSystem: boolean,
): Promise<Permission> {
  const existing = await repo.findByName(permissionName(action, subject));
  return existing ?? repo.create({ action, subject, isSystem });
}

async function rememberPermission(
  repo: PermissionRepository,
  known: Map<string, Permission>,
  action: string,
  subject: string,
  baseline: Set<string>,
): Promise<Permission> {
  const name = permissionName(action, subject);
  const already = known.get(name);
  if (already !== undefined) return already;

  const permission = await findOrCreatePermission(repo, action, subject, baseline.has(name));
  known.set(name, permission);
  return permission;
}

async function upsertRoles(
  roles: RoleRepository,
  permissions: PermissionRepository,
  seeds: SeedRole[],
  known: Map<string, Permission>,
  baseline: Set<string>,
): Promise<void> {
  for (const seed of seeds) {
    const role = await findOrCreateRole(roles, seed);
    const grants = await resolveGrantIds(permissions, known, seed.permissions, baseline);
    await roles.attachPermissions(role.id, grants);
  }
}

async function findOrCreateRole(repo: RoleRepository, seed: SeedRole): Promise<Role> {
  const existing = await repo.findByName(seed.name);
  return existing ?? repo.create({ name: seed.name, isSystem: seed.isSystem });
}

async function resolveGrantIds(
  repo: PermissionRepository,
  known: Map<string, Permission>,
  names: string[],
  baseline: Set<string>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) ids.push((await resolveGrant(repo, known, name, baseline)).id);
  return ids;
}

/**
 * A role may grant a permission the `permissions[]` list forgot to declare — the plan's own
 * baseline does exactly that with `manage:Post` — so a referenced name is upserted on
 * demand rather than rejected. Splitting on the FIRST colon mirrors `Permission.name` and
 * `@Permissions()`.
 */
async function resolveGrant(
  repo: PermissionRepository,
  known: Map<string, Permission>,
  name: string,
  baseline: Set<string>,
): Promise<Permission> {
  const declared = known.get(name);
  if (declared !== undefined) return declared;

  const separator = name.indexOf(':');
  if (separator === -1) {
    throw new Error(`Role references "${name}", which is not an "action:subject" permission`);
  }
  return rememberPermission(repo, known, name.slice(0, separator), name.slice(separator + 1), baseline);
}

function permissionName(action: string, subject: string): string {
  return `${action}:${subject}`;
}

function loadBaseline(): SeedFile {
  return JSON.parse(readFileSync(new URL('./rbac.seed.json', import.meta.url), 'utf8')) as SeedFile;
}

async function main(): Promise<void> {
  // Boot chatter stays off; only the seed's own summary and real failures are printed.
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'log'] });
  try {
    await runSeed(app.get(PERMISSION_REPOSITORY), app.get(ROLE_REPOSITORY));
  } finally {
    await app.close();
  }
}

try {
  await main();
} catch (error: unknown) {
  logger.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
