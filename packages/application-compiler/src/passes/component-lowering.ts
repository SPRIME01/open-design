import { ResolvedApplicationIR, Diagnostic, createErrorDiagnostic } from "@open-design/application-ir";

export const componentLoweringPass = {
  name: "component-lowering",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    for (const node of ir.frontend.nodes) {
      if (node.level === "component") {
        // Component level node validations
        if (node.kind === "form" && (!node.slots || !node.slots["fields"])) {
          diagnostics.push(
            createErrorDiagnostic("lowering_error", `Component form node '${node.id}' must specify fields slot.`, "lowering", { sourceFile: ir.bundle.modules.frontend, affectedIds: [node.id] })
          );
        }
      }
    }
    return { ir, diagnostics };
  }
};
