import { ResolvedApplicationIR, Diagnostic } from "@open-design/application-ir";

export const targetPlanningPass = {
  name: "target-planning",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    return { ir, diagnostics: [] };
  }
};
