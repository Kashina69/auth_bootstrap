import { PasswordService } from './password.service.js';

const PASSWORD = 'correct horse battery staple';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('hashes with argon2id and the OWASP parameters', async () => {
    await expect(passwords.hash(PASSWORD)).resolves.toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  });

  it('verifies the password it hashed', async () => {
    const hash = await passwords.hash(PASSWORD);
    await expect(passwords.verify(hash, PASSWORD)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await passwords.hash(PASSWORD);
    await expect(passwords.verify(hash, `${PASSWORD}!`)).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(passwords.verify('not-a-hash', PASSWORD)).resolves.toBe(false);
  });
});
