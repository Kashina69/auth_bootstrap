import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema.js';

/**
 * Typed accessor over the validated environment. Every value is read through the
 * schema-validated ConfigService, so a getter can never return something the boot-time
 * zod check rejected.
 */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get NODE_ENV(): Env['NODE_ENV'] {
    return this.config.get('NODE_ENV', { infer: true });
  }

  get AUTH_STRATEGY(): Env['AUTH_STRATEGY'] {
    return this.config.get('AUTH_STRATEGY', { infer: true });
  }

  get RBAC_STRATEGY(): Env['RBAC_STRATEGY'] {
    return this.config.get('RBAC_STRATEGY', { infer: true });
  }

  get DB_PROVIDER(): Env['DB_PROVIDER'] {
    return this.config.get('DB_PROVIDER', { infer: true });
  }

  get DATABASE_URL(): Env['DATABASE_URL'] {
    return this.config.get('DATABASE_URL', { infer: true });
  }

  get JWT_ALGORITHM(): Env['JWT_ALGORITHM'] {
    return this.config.get('JWT_ALGORITHM', { infer: true });
  }

  get JWT_PRIVATE_KEY(): Env['JWT_PRIVATE_KEY'] {
    return this.config.get('JWT_PRIVATE_KEY', { infer: true });
  }

  get JWT_PUBLIC_KEY(): Env['JWT_PUBLIC_KEY'] {
    return this.config.get('JWT_PUBLIC_KEY', { infer: true });
  }

  get JWT_SECRET(): Env['JWT_SECRET'] {
    return this.config.get('JWT_SECRET', { infer: true });
  }

  get REDIS_URL(): Env['REDIS_URL'] {
    return this.config.get('REDIS_URL', { infer: true });
  }

  /** Comma-separated in the environment; unset or empty means no origin is allowed. */
  get CORS_ORIGINS(): string[] {
    const configured = this.config.get('CORS_ORIGINS', { infer: true }) ?? '';
    return configured
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '');
  }
}
