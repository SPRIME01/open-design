import { Diagnostic, ResolvedApplicationIR, ProjectionTarget, ProjectionConfig } from "@open-design/application-ir";

export interface TargetCapabilitySet {
  features: string[];
  limitations: string[];
}

export interface AdapterContext {
  ir: ResolvedApplicationIR;
  targetConfig: ProjectionTarget;
  config: ProjectionConfig;
  componentRegistry?: any;
  priorManifest?: any;
}

export interface FileChange {
  path: string;
  content: string;
  sourceIds: string[];
}

export interface AdapterPlan {
  targetId: string;
  files: FileChange[];
  unresolved: string[];
  degradations: string[];
  permissions: string[];
  commands: { executable: string; argv: string[] }[];
  verificationSteps: { name: string; command: { executable: string; argv: string[] } }[];
}

export interface GeneratedFileSet {
  files: FileChange[];
}

export interface VerificationStep {
  name: string;
  command: { executable: string; argv: string[] };
}

export interface ApplicationTargetAdapter {
  readonly id: string;
  readonly version: string;
  readonly kind: 'frontend' | 'transport' | 'persistence' | 'compound';
  readonly supportedIr: {
    application: string;
    frontend?: string;
    boundary?: string;
    persistence?: string;
  };
  readonly capabilities: TargetCapabilitySet;

  validate(context: AdapterContext): Diagnostic[];
  plan(context: AdapterContext): Promise<AdapterPlan>;
  emit(plan: AdapterPlan): Promise<GeneratedFileSet>;
  verification(plan: AdapterPlan): VerificationStep[];
}
