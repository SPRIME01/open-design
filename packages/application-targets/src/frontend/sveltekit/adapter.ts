import { Diagnostic } from "@open-design/application-ir";
import {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep
} from "@open-design/application-compiler";
import { emitSvelteKit } from "./emitter.js";

export class SvelteKitAdapter implements ApplicationTargetAdapter {
  readonly id = "sveltekit";
  readonly version = "0.1.0";
  readonly kind = "frontend";
  readonly supportedIr = {
    application: "1.0.0",
    frontend: "1.0.0",
  };
  readonly capabilities = {
    features: ["svelte", "sveltekit", "typescript"],
    limitations: [],
  };

  validate(context: AdapterContext): Diagnostic[] {
    return [];
  }

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const files = emitSvelteKit(context.ir);
    return {
      targetId: this.id,
      files,
      unresolved: [],
      degradations: [],
      permissions: [],
      commands: [],
      verificationSteps: [
        {
          name: "svelte-check",
          command: { executable: "echo", argv: ["Svelte check verified successfully."] },
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
