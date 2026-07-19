import { z } from "zod";
import { idSchema, errorIdSchema, semanticVersionSchema } from "./common.js";

export const boundaryOperationSchema = z.object({
  id: idSchema,
  capability: z.string(),
  input: z.string(),
  output: z.string(),
  errors: z.array(z.string()),
  idempotencyKey: z.string().optional(),
});

export const boundarySchemaFieldSchema = z.object({
  id: idSchema,
  type: z.string(),
  required: z.boolean().optional(),
});

export const boundarySchemaDefSchema = z.object({
  id: idSchema,
  kind: z.string(), // e.g. "object"
  fields: z.array(boundarySchemaFieldSchema).optional(),
});

export const boundaryErrorDefSchema = z.object({
  id: errorIdSchema,
  presentationHint: z.string().optional(),
  field: z.string().optional(),
});

export const boundaryIRSchema = z.object({
  schemaVersion: semanticVersionSchema,
  applicationId: idSchema,
  operations: z.array(boundaryOperationSchema),
  schemas: z.array(boundarySchemaDefSchema),
  errors: z.array(boundaryErrorDefSchema),
  subscriptions: z.array(z.any()),
  versioningPolicy: z.string(),
});
