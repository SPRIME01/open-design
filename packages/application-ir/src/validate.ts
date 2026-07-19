import { z } from "zod";
import { Diagnostic, createErrorDiagnostic } from "./diagnostics.js";
import {
  applicationIRBundleSchema,
  domainIRSchema,
  capabilityIRSchema,
  boundaryIRSchema,
  persistenceIRSchema,
  frontendIRSchema
} from "./schemas/index.js";
import { ResolvedApplicationIR } from "./types.js";
import { resolveCrossReferences } from "./resolve.js";

function zodErrorToDiagnostics(err: z.ZodError, sourceFile: string): Diagnostic[] {
  return err.errors.map((e) => {
    const pointer = "/" + e.path.join("/");
    return createErrorDiagnostic(
      "schema_error",
      `Validation error: ${e.message} at ${pointer}`,
      "validation",
      {
        sourceFile,
        pointer,
      }
    );
  });
}

export function validateBundle(
  rawBundle: any,
  rawDomain: any,
  rawCapabilities: any,
  rawBoundary: any,
  rawPersistence: any,
  rawFrontend: any
): { ir?: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  const bundleVal = applicationIRBundleSchema.safeParse(rawBundle);
  if (!bundleVal.success) {
    diagnostics.push(...zodErrorToDiagnostics(bundleVal.error, "application.ir.json"));
  }

  const domainVal = domainIRSchema.safeParse(rawDomain);
  if (!domainVal.success) {
    diagnostics.push(...zodErrorToDiagnostics(domainVal.error, rawBundle?.modules?.domain || "domain.ir.json"));
  }

  const capVal = capabilityIRSchema.safeParse(rawCapabilities);
  if (!capVal.success) {
    diagnostics.push(...zodErrorToDiagnostics(capVal.error, rawBundle?.modules?.capabilities || "capabilities.ir.json"));
  }

  const boundVal = boundaryIRSchema.safeParse(rawBoundary);
  if (!boundVal.success) {
    diagnostics.push(...zodErrorToDiagnostics(boundVal.error, rawBundle?.modules?.boundary || "boundary.ir.json"));
  }

  const persistVal = persistenceIRSchema.safeParse(rawPersistence);
  if (!persistVal.success) {
    diagnostics.push(...zodErrorToDiagnostics(persistVal.error, rawBundle?.modules?.persistence || "persistence.ir.json"));
  }

  const frontVal = frontendIRSchema.safeParse(rawFrontend);
  if (!frontVal.success) {
    diagnostics.push(...zodErrorToDiagnostics(frontVal.error, rawBundle?.modules?.frontend || "frontend.ir.json"));
  }

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  const ir: ResolvedApplicationIR = {
    bundle: bundleVal.data!,
    domain: domainVal.data!,
    capabilities: capVal.data!,
    boundary: boundVal.data!,
    persistence: persistVal.data!,
    frontend: frontVal.data!,
  };

  const refErrors = resolveCrossReferences(ir);
  diagnostics.push(...refErrors);

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  return { ir, diagnostics: [] };
}
