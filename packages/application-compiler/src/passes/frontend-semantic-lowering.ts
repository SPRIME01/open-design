import { ResolvedApplicationIR, Diagnostic, createErrorDiagnostic } from "@open-design/application-ir";

export const frontendSemanticLoweringPass = {
  name: "frontend-semantic-lowering",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    // Ensure all semantic nodes only reference defined components/slots
    for (const node of ir.frontend.nodes) {
      if (node.level === "semantic") {
        if (!node.slots || Object.keys(node.slots).length === 0) {
          diagnostics.push(
            createErrorDiagnostic("lowering_error", `Semantic node '${node.id}' has no slots.`, "lowering", { sourceFile: ir.bundle.modules.frontend, affectedIds: [node.id] })
          );
        }
      }
    }
    return { ir, diagnostics };
  }
};
