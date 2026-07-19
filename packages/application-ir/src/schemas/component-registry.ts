import { z } from "zod";

export const componentMappingSchema = z.object({
  import: z.string(),
  export: z.string().optional(),
  props: z.record(z.any()).optional(),
  variants: z.record(z.any()).optional(),
  events: z.record(z.any()).optional(),
  slots: z.record(z.any()).optional(),
  children: z.string().optional(),
  requiredTarget: z.string().optional(),
  accessibilityGuarantees: z.array(z.string()).optional(),
  version: z.string().optional(),
});

export const componentRegistrySchema = z.object({
  schemaVersion: z.number(),
  target: z.string(),
  mappings: z.record(componentMappingSchema),
});

