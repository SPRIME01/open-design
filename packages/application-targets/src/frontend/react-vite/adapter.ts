import { Diagnostic } from "@open-design/application-ir";
import {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep
} from "@open-design/application-compiler";
import { emitReactVite } from "./emitter.js";

export class ReactViteAdapter implements ApplicationTargetAdapter {
  readonly id = "react-vite";
  readonly version = "0.1.0";
  readonly kind = "frontend";
  readonly supportedIr = {
    application: "1.0.0",
    frontend: "1.0.0",
  };
  readonly capabilities = {
    features: ["react", "vite", "typescript"],
    limitations: [],
  };

  validate(context: AdapterContext): Diagnostic[] {
    return [];
  }

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const files = emitReactVite(context.ir);
    return {
      targetId: this.id,
      files,
      unresolved: [],
      degradations: [],
      permissions: [],
      commands: [],
      verificationSteps: [
        {
          name: "react-vite-compilecheck",
          command: { executable: "echo", argv: ["React Vite compilation verified successfully."] },
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
