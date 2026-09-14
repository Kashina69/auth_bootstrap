import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'node:path';
import { AppConfig } from '../config/app-config.service.js';

/** The generated SDL is written next to the source so schema changes show up in review. */
const SCHEMA_FILE = join(process.cwd(), 'src/schema.gql');

/**
 * The GraphQL half of the parity pattern (plan.md §10). Code-first: the schema is derived
 * from the decorators on the shared DTOs and on the resolvers, so the REST body types and
 * the GraphQL inputs stay one artefact rather than two that must be kept in step.
 *
 * Introspection and the playground describe every query, mutation and field — including
 * the ones guards protect — so both are development-only (plan.md §8).
 */
@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => graphqlOptions(config),
    }),
  ],
})
export class GraphqlModule {}

function graphqlOptions(config: AppConfig): ApolloDriverConfig {
  const isProduction = config.NODE_ENV === 'production';
  return {
    autoSchemaFile: SCHEMA_FILE,
    sortSchema: true,
    introspection: !isProduction,
    playground: !isProduction,
  };
}
