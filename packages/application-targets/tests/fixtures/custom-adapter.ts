import { Diagnostic } from "@open-design/application-ir";
import {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep
} from "@open-design/application-compiler";

export class CustomTxtAdapter implements ApplicationTargetAdapter {
  readonly id = "custom-txt";
  readonly version = "0.1.0";
  readonly kind = "compound";
  readonly supportedIr = {
    application: "1.0.0",
  };
  readonly capabilities = {
    features: ["custom-text-summary"],
    limitations: [],
  };

  validate(context: AdapterContext): Diagnostic[] {
    return [];
  }

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const summary = `Application ID: ${context.ir.bundle.applicationId}\nName: ${context.ir.bundle.name}\nScreens Count: ${context.ir.frontend.screens.length}`;
    return {
      targetId: this.id,
      files: [
        {
          path: "summary.txt",
          content: summary,
          sourceIds: [context.ir.bundle.applicationId],
        }
      ],
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
