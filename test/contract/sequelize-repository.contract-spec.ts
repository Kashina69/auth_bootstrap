import { defineRepositoryContract } from './repository-contract.js';
import { createSequelizeHarness } from './support/sequelize-factory.js';

defineRepositoryContract('Sequelize repositories', createSequelizeHarness);
