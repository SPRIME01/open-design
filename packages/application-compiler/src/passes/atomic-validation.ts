import { ResolvedApplicationIR, Diagnostic, createErrorDiagnostic } from "@open-design/application-ir";

const ALLOWED_ATOMIC_KINDS = new Set([
  "button", "link", "input", "textarea", "select", "checkbox", "radio", "switch",
  "text", "heading", "image", "icon", "code", "list", "separator",
  "container", "stack", "inline", "grid", "split", "overlay", "scroll-area", "spacer",
  "status", "alert", "progress", "skeleton",
  "form", "table", "dialog", "disclosure", "tabs"
]);

export const atomicValidationPass = {
  name: "atomic-validation",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    for (const node of ir.frontend.nodes) {
      if (node.level === "atomic") {
        if (!ALLOWED_ATOMIC_KINDS.has(node.kind)) {
          diagnostics.push(
            createErrorDiagnostic(
              "lowering_error",
              `Atomic node '${node.id}' has unsupported atomic kind '${node.kind}'.`,
              "lowering",
              { sourceFile: ir.bundle.modules.frontend, affectedIds: [node.id] }
            )
          );
        }
      }
    }
    return { ir, diagnostics };
  }
};
