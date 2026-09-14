import { defineRepositoryContract } from './repository-contract.js';
import { createMongooseHarness } from './support/mongoose-factory.js';

defineRepositoryContract('Mongoose repositories', createMongooseHarness);
