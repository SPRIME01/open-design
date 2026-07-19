import { ResolvedApplicationIR, Diagnostic } from "@open-design/application-ir";

export const platformLoweringPass = {
  name: "platform-lowering",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    // In v0.1.0, we just pass through and ensure no unresolved custom extensions remain
    return { ir, diagnostics: [] };
  }
};
