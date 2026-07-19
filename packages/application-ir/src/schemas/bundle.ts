import { z } from "zod";
import { idSchema, semanticVersionSchema, relativePathSchema } from "./common.js";

export const bundleModuleRefsSchema = z.object({
  domain: relativePathSchema,
  capabilities: relativePathSchema,
  boundary: relativePathSchema,
  persistence: relativePathSchema,
  frontend: relativePathSchema,
});

export const bundleSourceSchema = z.object({
  projectId: z.string(),
  runId: z.string(),
  parentBundleHash: z.string().nullable(),
});

export const bundleExtensionSchema = z.object({
  namespace: z.string(),
  version: semanticVersionSchema,
  required: z.boolean(),
});

export const applicationIRBundleSchema = z.object({
  schemaVersion: semanticVersionSchema,
  applicationId: idSchema,
  name: z.string(),
  modules: bundleModuleRefsSchema,
  source: bundleSourceSchema,
  extensions: z.array(bundleExtensionSchema).optional(),
  metadata: z.record(z.any()).optional(),
});
