import { z } from "zod";
import {
  applicationIRBundleSchema,
  domainIRSchema,
  capabilityIRSchema,
  boundaryIRSchema,
  persistenceIRSchema,
  frontendIRSchema,
  frontendNodeSchema,
  projectionConfigSchema,
  projectionTargetSchema,
  componentRegistrySchema
} from "./schemas/index.js";

export type ApplicationIRBundle = z.infer<typeof applicationIRBundleSchema>;
export type DomainIR = z.infer<typeof domainIRSchema>;
export type CapabilityIR = z.infer<typeof capabilityIRSchema>;
export type BoundaryIR = z.infer<typeof boundaryIRSchema>;
export type PersistenceIR = z.infer<typeof persistenceIRSchema>;
export type FrontendIR = z.infer<typeof frontendIRSchema>;
export type FrontendNode = z.infer<typeof frontendNodeSchema>;
export type ProjectionConfig = z.infer<typeof projectionConfigSchema>;
export type ProjectionTarget = z.infer<typeof projectionTargetSchema>;
export type ComponentRegistry = z.infer<typeof componentRegistrySchema>;

export interface ResolvedApplicationIR {
  bundle: ApplicationIRBundle;
  domain: DomainIR;
  capabilities: CapabilityIR;
  boundary: BoundaryIR;
  persistence: PersistenceIR;
  frontend: FrontendIR;
}
