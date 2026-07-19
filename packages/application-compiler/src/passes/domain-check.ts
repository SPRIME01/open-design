import { ResolvedApplicationIR, Diagnostic, createErrorDiagnostic } from "@open-design/application-ir";

export const domainCheckPass = {
  name: "domain-check",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    for (const ent of ir.domain.entities) {
      if (ent.fields.length === 0) {
        diagnostics.push(
          createErrorDiagnostic("domain_validation_error", `Domain entity '${ent.id}' has no fields defined.`, "validation", { sourceFile: ir.bundle.modules.domain, affectedIds: [ent.id] })
        );
      }
    }
    return { ir, diagnostics };
  }
};
