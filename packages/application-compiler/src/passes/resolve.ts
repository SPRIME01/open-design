import { ResolvedApplicationIR, Diagnostic, resolveCrossReferences } from "@open-design/application-ir";

export const resolvePass = {
  name: "resolve",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    const diagnostics = resolveCrossReferences(ir);
    return { ir, diagnostics };
  }
};
