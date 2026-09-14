import { defineRepositoryContract } from './repository-contract.js';
import { createPrismaHarness } from './support/prisma-factory.js';

defineRepositoryContract('Prisma repositories', createPrismaHarness);
