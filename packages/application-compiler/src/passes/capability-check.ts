import { ResolvedApplicationIR, Diagnostic, createErrorDiagnostic } from "@open-design/application-ir";

export const capabilityCheckPass = {
  name: "capability-check",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const schemas = new Set(ir.boundary.schemas.map(s => s.id));
    const entities = new Set(ir.domain.entities.map(e => e.id));

    // Verify inputs/outputs match schema or domain entities or "void"
    for (const query of ir.capabilities.queries) {
      if (query.input !== "void" && !schemas.has(query.input) && !entities.has(query.input)) {
        diagnostics.push(
          createErrorDiagnostic("capability_validation_error", `Query '${query.id}' input schema '${query.input}' cannot be resolved.`, "validation", { sourceFile: ir.bundle.modules.capabilities, affectedIds: [query.id] })
        );
      }
      if (query.output !== "void" && !schemas.has(query.output) && !entities.has(query.output)) {
        diagnostics.push(
          createErrorDiagnostic("capability_validation_error", `Query '${query.id}' output schema '${query.output}' cannot be resolved.`, "validation", { sourceFile: ir.bundle.modules.capabilities, affectedIds: [query.id] })
        );
      }
    }

    for (const command of ir.capabilities.commands) {
      if (command.input !== "void" && !schemas.has(command.input) && !entities.has(command.input)) {
        diagnostics.push(
          createErrorDiagnostic("capability_validation_error", `Command '${command.id}' input schema '${command.input}' cannot be resolved.`, "validation", { sourceFile: ir.bundle.modules.capabilities, affectedIds: [command.id] })
        );
      }
      if (command.output !== "void" && !schemas.has(command.output) && !entities.has(command.output)) {
        diagnostics.push(
          createErrorDiagnostic("capability_validation_error", `Command '${command.id}' output schema '${command.output}' cannot be resolved.`, "validation", { sourceFile: ir.bundle.modules.capabilities, affectedIds: [command.id] })
        );
      }
    }

    return { ir, diagnostics };
  }
};
