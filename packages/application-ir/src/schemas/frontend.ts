import { z } from "zod";
import { idSchema, semanticVersionSchema } from "./common.js";

export const frontendRouteSchema = z.object({
  id: idSchema,
  path: z.string(),
  screen: z.string(),
});

export const frontendScreenSchema = z.object({
  id: idSchema,
  rootNode: z.string(),
});

export const frontendNodeActionSchema = z.object({
  trigger: z.string(),
  operation: z.string().optional(),
  intent: z.string().optional(),
  input: z.record(z.any()).optional(),
});

export const frontendNodeSchema = z.object({
  id: idSchema,
  level: z.enum(["semantic", "component", "atomic", "extension"]),
  kind: z.string(),
  children: z.array(z.string()).optional(),
  slots: z.record(z.array(z.string())).optional(),
  bindings: z.array(z.any()).optional(),
  actions: z.array(frontendNodeActionSchema).optional(),
  states: z.array(z.string()).optional(),
  styleIntent: z.record(z.any()).optional(),
  responsive: z.record(z.any()).optional(),
  accessibility: z.record(z.any()).optional(),
  sourceRef: z.string().optional(),
});

export const frontendOperationBindingSchema = z.object({
  node: z.string(),
  operation: z.string(),
});

export const frontendAccessibilityDefaultsSchema = z.object({
  focusVisible: z.boolean().optional(),
  reducedMotion: z.boolean().optional(),
});

export const frontendIRSchema = z.object({
  schemaVersion: semanticVersionSchema,
  applicationId: idSchema,
  routes: z.array(frontendRouteSchema),
  screens: z.array(frontendScreenSchema),
  components: z.array(z.any()),
  nodes: z.array(frontendNodeSchema),
  flows: z.array(z.any()),
  localState: z.array(z.any()),
  operationBindings: z.array(frontendOperationBindingSchema),
  tokenReferences: z.array(z.string()),
  accessibilityDefaults: frontendAccessibilityDefaultsSchema,
});
