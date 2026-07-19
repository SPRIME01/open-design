import { Diagnostic } from "@open-design/application-ir";
import {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep
} from "@open-design/application-compiler";
import { emitMockLocal } from "./emitter.js";

export class MockLocalAdapter implements ApplicationTargetAdapter {
  readonly id = "mock-local";
  readonly version = "0.1.0";
  readonly kind = "transport";
  readonly supportedIr = {
    application: "1.0.0",
    boundary: "1.0.0",
  };
  readonly capabilities = {
    features: ["mock-latency", "in-memory-state"],
    limitations: ["no-durable-storage"],
  };

  validate(context: AdapterContext): Diagnostic[] {
    return [];
  }

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const files = emitMockLocal(context.ir);
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
