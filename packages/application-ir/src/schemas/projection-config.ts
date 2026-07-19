import { z } from "zod";
import { idSchema, relativePathSchema } from "./common.js";

export const projectionTargetSchema = z.object({
  id: idSchema,
  adapter: z.string(),
  mode: z.enum(["scaffold", "integrate"]).default("scaffold"),
  outputRoot: relativePathSchema,
  frontend: z.object({
    adapter: z.string(),
    language: z.string().optional(),
    router: z.string().optional(),
    styling: z.string().optional(),
  }),
  transport: z.object({
    adapter: z.string(),
  }).optional(),
  persistence: z.object({
    adapter: z.string(),
  }).optional(),
  paths: z.record(z.string()).optional(),
  componentRegistry: z.string().nullable().optional(),
  verification: z.record(z.boolean()).optional(),
  capabilityPolicy: z.enum(["degrade", "omit", "block"]).optional(),
  conflictPolicy: z.enum(["block", "plan-only", "force"]).optional(),
});

export const projectionConfigSchema = z.object({
  schemaVersion: z.number(),
  application: z.string(),
  targets: z.array(projectionTargetSchema),
  trust: z.object({
    allowCustomAdapters: z.boolean().optional(),
  }).optional(),
  execution: z.object({
    allowInstall: z.boolean().optional(),
    allowVerificationCommands: z.boolean().optional(),
  }).optional(),
});

