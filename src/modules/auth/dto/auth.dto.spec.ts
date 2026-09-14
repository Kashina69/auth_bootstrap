import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CheckPermissionDto } from './check-permission.dto.js';
import { LoginDto } from './login.dto.js';
import { RefreshDto } from './refresh.dto.js';
import { RegisterDto } from './register.dto.js';

/** The exact pipe `configure-app.ts` installs globally. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

function submit<T>(metatype: new () => T, body: unknown): Promise<T> {
  return pipe.transform(body, { type: 'body', metatype, data: undefined }) as Promise<T>;
}

describe('RegisterDto', () => {
  const valid = { email: 'user@example.com', password: 'Passw0rd!' };

  it('accepts a strongly-shaped registration', async () => {
    await expect(submit(RegisterDto, valid)).resolves.toBeInstanceOf(RegisterDto);
  });

  it.each([
    ['no lowercase letter', 'PASSW0RD!'],
    ['no uppercase letter', 'passw0rd!'],
    ['no digit', 'Password!'],
    ['no symbol', 'Passw0rd'],
  ])('rejects a password with %s', async (_case, password) => {
    await expect(submit(RegisterDto, { ...valid, password })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a password shorter than the eight-character floor', async () => {
    await expect(submit(RegisterDto, { ...valid, password: 'Pw0rd!' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a malformed email', async () => {
    await expect(submit(RegisterDto, { ...valid, email: 'not-an-email' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a field the client is not allowed to set', async () => {
    // `forbidNonWhitelisted` is what stops a body smuggling in state the server owns.
    await expect(
      submit(RegisterDto, { ...valid, isActive: true, roles: ['admin'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('strips nothing it needs when the body is well-formed', async () => {
    const result = await submit(RegisterDto, valid);

    expect(result).toEqual(valid);
  });
});

describe('LoginDto', () => {
  it('accepts any non-empty password, including one that would fail registration', async () => {
    // Rejecting a weak password here would answer "wrong password" with a validation
    // error and turn the endpoint into a password-policy oracle for existing accounts.
    await expect(submit(LoginDto, { email: 'user@example.com', password: 'x' })).resolves.toBeInstanceOf(
      LoginDto,
    );
  });

  it('still rejects an empty password, which no real credential has', async () => {
    await expect(submit(LoginDto, { email: 'user@example.com', password: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a malformed email', async () => {
    await expect(submit(LoginDto, { email: 'nope', password: 'whatever' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('RefreshDto', () => {
  it('accepts an opaque token of any shape', async () => {
    await expect(submit(RefreshDto, { refreshToken: 'opaque.jwt.value' })).resolves.toBeInstanceOf(
      RefreshDto,
    );
  });

  it('rejects an empty token', async () => {
    await expect(submit(RefreshDto, { refreshToken: '' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing token', async () => {
    await expect(submit(RefreshDto, {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CheckPermissionDto', () => {
  const valid = { action: 'update', subject: 'Post' };

  it('accepts a permission pair', async () => {
    await expect(submit(CheckPermissionDto, valid)).resolves.toBeInstanceOf(CheckPermissionDto);
  });

  it('accepts a subject that itself contains a colon', async () => {
    // `can()` takes action and subject separately precisely so this is expressible.
    await expect(
      submit(CheckPermissionDto, { action: 'update', subject: 'Sub:Thing' }),
    ).resolves.toBeInstanceOf(CheckPermissionDto);
  });

  it('rejects an empty action or subject', async () => {
    await expect(submit(CheckPermissionDto, { ...valid, action: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(submit(CheckPermissionDto, { ...valid, subject: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-string subject', async () => {
    await expect(submit(CheckPermissionDto, { action: 'update', subject: 42 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an over-long action', async () => {
    await expect(submit(CheckPermissionDto, { ...valid, action: 'a'.repeat(65) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
