import { z } from 'zod';

/**
 * Verbatim from implementation.spec.md §8, with one frozen change: DB_PROVIDER lists
 * Mongoose in place of TypeORM (CONTRACTS.md §7, MEMORY.md kickoff decision).
 * Cross-field rules live in superRefine so a missing secret is a boot failure, never a
 * silent insecure fallback.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    AUTH_STRATEGY: z.enum(['jwt-stateless', 'session-redis']).default('jwt-stateless'),
    RBAC_STRATEGY: z.enum(['embedded-claims', 'db-live']).default('embedded-claims'),
    DB_PROVIDER: z.enum(['prisma', 'drizzle', 'sequelize', 'mongoose']).default('prisma'),
    DATABASE_URL: z.string().url(),
    JWT_ALGORITHM: z.enum(['RS256', 'HS256']).default('RS256'),
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_PUBLIC_KEY: z.string().optional(),
    JWT_SECRET: z.string().min(32).optional(),
    REDIS_URL: z.string().url().optional(),
    CORS_ORIGINS: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.JWT_ALGORITHM === 'RS256' && (!val.JWT_PRIVATE_KEY || !val.JWT_PUBLIC_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'RS256 requires JWT_PRIVATE_KEY and JWT_PUBLIC_KEY' });
    }
    if (val.JWT_ALGORITHM === 'HS256' && !val.JWT_SECRET) {
      ctx.addIssue({ code: 'custom', message: 'HS256 requires JWT_SECRET (min 32 chars)' });
    }
    if ((val.AUTH_STRATEGY === 'session-redis' || val.RBAC_STRATEGY === 'db-live') && !val.REDIS_URL) {
      ctx.addIssue({ code: 'custom', message: 'REDIS_URL is required for session-redis or db-live' });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) throw new Error(formatEnvIssues(result.error));
  return result.data;
}

function formatEnvIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return ['Invalid environment configuration — refusing to start:', ...lines].join('\n');
}
