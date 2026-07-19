import { ResolvedApplicationIR, Diagnostic } from "@open-design/application-ir";
import { resolvePass } from "./passes/resolve.js";
import { normalizePass } from "./passes/normalize.js";
import { domainCheckPass } from "./passes/domain-check.js";
import { capabilityCheckPass } from "./passes/capability-check.js";
import { frontendSemanticLoweringPass } from "./passes/frontend-semantic-lowering.js";
import { componentLoweringPass } from "./passes/component-lowering.js";
import { atomicValidationPass } from "./passes/atomic-validation.js";
import { platformLoweringPass } from "./passes/platform-lowering.js";
import { targetPlanningPass } from "./passes/target-planning.js";

export const orderedLoweringPasses = [
  resolvePass,
  normalizePass,
  domainCheckPass,
  capabilityCheckPass,
  frontendSemanticLoweringPass,
  componentLoweringPass,
  atomicValidationPass,
  platformLoweringPass,
  targetPlanningPass,
];

export function runLoweringPipeline(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
  let currentIr = ir;
  const diagnostics: Diagnostic[] = [];

  for (const pass of orderedLoweringPasses) {
    const result = pass.run(currentIr);
    currentIr = result.ir;
    if (result.diagnostics.length > 0) {
      diagnostics.push(...result.diagnostics);
      // If a pass has errors, we can stop execution
      if (result.diagnostics.some((d) => d.severity === "error")) {
        break;
      }
    }
  }

  return { ir: currentIr, diagnostics };
}
