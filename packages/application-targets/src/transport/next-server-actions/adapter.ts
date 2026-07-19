import { Diagnostic } from "@open-design/application-ir";
import {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep
} from "@open-design/application-compiler";
import { emitNextServerActions } from "./emitter.js";

export class NextServerActionsAdapter implements ApplicationTargetAdapter {
  readonly id = "next-server-actions";
  readonly version = "0.1.0";
  readonly kind = "transport";
  readonly supportedIr = {
    application: "1.0.0",
    boundary: "1.0.0",
  };
  readonly capabilities = {
    features: ["server-actions", "runtime-validation"],
    limitations: [],
  };

  validate(context: AdapterContext): Diagnostic[] {
    return [];
  }

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const files = emitNextServerActions(context.ir);
    return {
      targetId: this.id,
      files,
      unresolved: [],
      degradations: [],
      permissions: [],
      commands: [],
      verificationSteps: [],
    };
  }

  async emit(plan: AdapterPlan): Promise<GeneratedFileSet> {
    return {
      files: plan.files,
    };
  }

  verification(plan: AdapterPlan): VerificationStep[] {
    return plan.verificationSteps;
  }
}
