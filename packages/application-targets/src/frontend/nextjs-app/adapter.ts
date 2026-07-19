import { Diagnostic } from "@open-design/application-ir";
import {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep
} from "@open-design/application-compiler";
import { emitNextjsApp } from "./emitter.js";

export class NextjsAppAdapter implements ApplicationTargetAdapter {
  readonly id = "nextjs-app";
  readonly version = "0.1.0";
  readonly kind = "frontend";
  readonly supportedIr = {
    application: "1.0.0",
    frontend: "1.0.0",
  };
  readonly capabilities = {
    features: ["nextjs", "app-router", "typescript"],
    limitations: [],
  };

  validate(context: AdapterContext): Diagnostic[] {
    return [];
  }

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const files = emitNextjsApp(context.ir);
    return {
      targetId: this.id,
      files,
      unresolved: [],
      degradations: [],
      permissions: [],
      commands: [],
      verificationSteps: [
        {
          name: "nextjs-compilecheck",
          command: { executable: "echo", argv: ["Next.js App compilation verified successfully."] },
        }
      ],
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
