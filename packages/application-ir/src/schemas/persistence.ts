import { z } from "zod";
import { idSchema, semanticVersionSchema } from "./common.js";

export const persistenceAggregateSchema = z.object({
  id: idSchema,
  rootEntity: z.string(),
  transactionBoundary: z.boolean(),
});

export const persistenceRepositorySchema = z.object({
  id: idSchema,
  aggregate: z.string(),
  operations: z.array(z.string()),
});

export const persistenceIndexSchema = z.object({
  id: idSchema,
  entity: z.string(),
  fields: z.array(z.string()),
  unique: z.boolean(),
});

export const persistenceUniquenessSchema = z.object({
  id: idSchema,
  entity: z.string(),
  fields: z.array(z.string()),
});

export const persistenceDeletionPolicySchema = z.object({
  entity: z.string(),
  mode: z.string(), // e.g. "soft", "hard"
});

export const persistenceConcurrencySchema = z.object({
  aggregate: z.string(),
  strategy: z.string(), // e.g. "optimistic", "pessimistic"
  versionField: z.string(),
});

export const persistenceIRSchema = z.object({
  schemaVersion: semanticVersionSchema,
  applicationId: idSchema,
  aggregates: z.array(persistenceAggregateSchema),
  repositories: z.array(persistenceRepositorySchema),
  relations: z.array(z.any()),
  indexes: z.array(persistenceIndexSchema),
  uniqueness: z.array(persistenceUniquenessSchema),
  retention: z.array(z.any()),
  deletionPolicies: z.array(persistenceDeletionPolicySchema),
  concurrency: z.array(persistenceConcurrencySchema),
  migrationIntent: z.array(z.any()),
});
