import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AssignRoleDto } from './assign-role.dto.js';
import { AttachPermissionsDto } from './attach-permissions.dto.js';
import { CreateRoleDto } from './create-role.dto.js';

/** The exact pipe `configure-app.ts` installs globally. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

function submit<T>(metatype: new () => T, body: unknown): Promise<T> {
  return pipe.transform(body, { type: 'body', metatype, data: undefined }) as Promise<T>;
}

describe('CreateRoleDto', () => {
  it('accepts a plain role name', async () => {
    await expect(submit(CreateRoleDto, { name: 'editor' })).resolves.toBeInstanceOf(CreateRoleDto);
  });

  it('accepts the separators role names may use', async () => {
    await expect(submit(CreateRoleDto, { name: 'team:editor-v2' })).resolves.toBeInstanceOf(CreateRoleDto);
  });

  it('rejects a name that does not start alphanumerically', async () => {
    await expect(submit(CreateRoleDto, { name: ':editor' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a name carrying whitespace or a slash', async () => {
    await expect(submit(CreateRoleDto, { name: 'team editor' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(submit(CreateRoleDto, { name: 'team/editor' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a client-supplied isSystem flag, which is a server-side baseline', async () => {
    await expect(submit(CreateRoleDto, { name: 'editor', isSystem: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('treats the description as optional', async () => {
    await expect(submit(CreateRoleDto, { name: 'editor' })).resolves.toBeInstanceOf(CreateRoleDto);
    await expect(
      submit(CreateRoleDto, { name: 'editor', description: 'may edit posts' }),
    ).resolves.toBeInstanceOf(CreateRoleDto);
  });

  it('rejects an over-long description', async () => {
    await expect(
      submit(CreateRoleDto, { name: 'editor', description: 'x'.repeat(256) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AssignRoleDto', () => {
  it('accepts a role id', async () => {
    await expect(submit(AssignRoleDto, { roleId: 'role-1' })).resolves.toBeInstanceOf(AssignRoleDto);
  });

  it('rejects an empty role id, which would assign nothing', async () => {
    await expect(submit(AssignRoleDto, { roleId: '' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing role id', async () => {
    await expect(submit(AssignRoleDto, {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AttachPermissionsDto', () => {
  it('accepts a non-empty list of permission names', async () => {
    await expect(
      submit(AttachPermissionsDto, { permissions: ['read:Post', 'manage:User'] }),
    ).resolves.toBeInstanceOf(AttachPermissionsDto);
  });

  it('rejects an empty list, which would silently grant nothing', async () => {
    await expect(submit(AttachPermissionsDto, { permissions: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a list holding a non-string', async () => {
    await expect(submit(AttachPermissionsDto, { permissions: ['read:Post', 7] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a bare string where the list belongs', async () => {
    await expect(submit(AttachPermissionsDto, { permissions: 'read:Post' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
