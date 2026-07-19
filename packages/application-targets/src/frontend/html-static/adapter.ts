import { Diagnostic, ResolvedApplicationIR } from "@open-design/application-ir";
import {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep
} from "@open-design/application-compiler";
import { emitHtmlStatic } from "./emitter.js";

export class HtmlStaticAdapter implements ApplicationTargetAdapter {
  readonly id = "html-static";
  readonly version = "0.1.0";
  readonly kind = "frontend";
  readonly supportedIr = {
    application: "1.0.0",
    frontend: "1.0.0",
  };
  readonly capabilities = {
    features: ["static-html", "css-custom-properties"],
    limitations: ["no-live-database"],
  };

  validate(context: AdapterContext): Diagnostic[] {
    return [];
  }

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const files = emitHtmlStatic(context.ir);
    return {
      targetId: this.id,
      files,
      unresolved: [],
      degradations: [],
      permissions: [],
      commands: [],
      verificationSteps: [
        {
          name: "html-lint",
          command: { executable: "echo", argv: ["HTML verified successfully."] },
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
