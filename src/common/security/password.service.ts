import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing — implementation.spec.md §1, verbatim.
 *
 * Argon2id with the OWASP-recommended minimum parameters. Every password comparison in
 * the codebase goes through `verify`: `argon2.verify` is constant-time internally, so no
 * caller is ever allowed to compare two password strings itself (spec §1 rules).
 */
@Injectable()
export class PasswordService {
  private readonly hashOptions: argon2.HashOptions = {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB — OWASP minimum recommendation for argon2id
    timeCost: 2,
    parallelism: 1,
  };

  async hash(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, this.hashOptions);
  }

  async verify(hash: string, plainPassword: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainPassword);
    } catch {
      // Malformed hash, wrong algorithm, etc. — treat as failed auth, never throw upward.
      return false;
    }
  }
}
