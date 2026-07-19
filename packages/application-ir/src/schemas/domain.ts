import { z } from "zod";
import { idSchema, semanticVersionSchema } from "./common.js";

export const domainFieldSchema = z.object({
  id: idSchema,
  type: z.string(),
  generated: z.boolean().optional(),
  default: z.any().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
});

export const domainEntitySchema = z.object({
  id: idSchema,
  identity: z.string(),
  fields: z.array(domainFieldSchema),
  invariants: z.array(z.string()).optional(),
});

export const domainEnumSchema = z.object({
  id: idSchema,
  values: z.array(z.string()),
});

export const domainInvariantSchema = z.object({
  id: idSchema,
  description: z.string(),
});

export const domainTransitionSchema = z.object({
  id: idSchema,
  from: z.array(z.string()),
  to: z.string(),
});

export const domainStateMachineSchema = z.object({
  id: idSchema,
  states: z.array(z.string()),
  transitions: z.array(domainTransitionSchema),
});

export const domainIRSchema = z.object({
  schemaVersion: semanticVersionSchema,
  applicationId: idSchema,
  entities: z.array(domainEntitySchema),
  enums: z.array(domainEnumSchema),
  valueObjects: z.array(z.any()),
  scalarTypes: z.array(z.any()),
  invariants: z.array(domainInvariantSchema),
  stateMachines: z.array(domainStateMachineSchema),
});
