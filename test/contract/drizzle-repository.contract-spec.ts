import { defineRepositoryContract } from './repository-contract.js';
import { createDrizzleHarness } from './support/drizzle-factory.js';

defineRepositoryContract('Drizzle repositories', createDrizzleHarness);
