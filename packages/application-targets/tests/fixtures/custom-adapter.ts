import { Diagnostic } from "@open-design/application-ir";
import {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep
} from "@open-design/application-compiler";

export interface CustomTxtAdapterOptions {
  /** Registry id; defaults to "custom-txt". */
  id?: string;
  /** Verification steps the adapter's plan declares; empty by default. */
  verificationSteps?: VerificationStep[];
}

export class CustomTxtAdapter implements ApplicationTargetAdapter {
  readonly id: string;
  readonly version = "0.1.0";
  readonly kind = "compound";
  readonly supportedIr = {
    application: "1.0.0",
  };
  readonly capabilities = {
    features: ["custom-text-summary"],
    limitations: [],
  };

  /**
   * Verification steps declared by plan(). Mutable on purpose: a test can
   * re-point the adapter at a corrected step while keeping the same registry
   * identity, so a failing and a passing variant differ in the step outcome
   * only — never in targetId, adapterVersions, or the emitted files.
   */
  verificationSteps: VerificationStep[];

  constructor(options: CustomTxtAdapterOptions = {}) {
    this.id = options.id ?? "custom-txt";
    this.verificationSteps = options.verificationSteps ?? [];
  }

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
      verificationSteps: this.verificationSteps,
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
