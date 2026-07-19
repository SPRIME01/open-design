import { z } from "zod";
import { idSchema, errorIdSchema, semanticVersionSchema } from "./common.js";


export const capabilityQuerySchema = z.object({
  id: idSchema,
  input: z.string(), // can be "void"
  output: z.string(),
  authorization: z.string().optional(),
  errors: z.array(z.string()),
});

export const capabilityEffectSchema = z.object({
  kind: z.string(), // e.g. "create", "emit"
  entity: z.string().optional(),
  event: z.string().optional(),
});

export const capabilityCommandSchema = z.object({
  id: idSchema,
  input: z.string(),
  output: z.string(),
  transactional: z.boolean(),
  idempotency: z.string(),
  authorization: z.string().optional(),
  preconditions: z.array(z.any()).optional(),
  effects: z.array(capabilityEffectSchema),
  errors: z.array(z.string()),
});

export const capabilityEventSchema = z.object({
  id: idSchema,
  payload: z.string(),
  ordering: z.string(),
  replay: z.string(),
  criticality: z.string(),
});

export const capabilityErrorSchema = z.object({
  id: errorIdSchema,
  recoverable: z.boolean(),
});


export const capabilityIRSchema = z.object({
  schemaVersion: semanticVersionSchema,
  applicationId: idSchema,
  queries: z.array(capabilityQuerySchema),
  commands: z.array(capabilityCommandSchema),
  events: z.array(capabilityEventSchema),
  workflows: z.array(z.any()),
  authorizationCapabilities: z.array(z.string()),
  errorCatalog: z.array(capabilityErrorSchema),
});
