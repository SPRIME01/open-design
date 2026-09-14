
export interface CompilerTargetInfo {
  id: string;
  version: string;
  kind: 'frontend' | 'transport' | 'persistence' | 'compound';
  features: string[];
  limitations: string[];
}

export interface CompilerDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "advisory";
  phase: "validation" | "lowering" | "planning" | "write" | "verification";
  sourceFile?: string;
  pointer?: string;
  affectedIds?: string[];
  recommendedAction?: string;
}

export interface CompilerValidationResult {
  valid: boolean;
  diagnostics: CompilerDiagnostic[];
}

export interface CompilerValidateRequest {
  projectRoot: string;
}

export interface CompilerPlanSummary {
  planHash: string;
  targetId: string;
  creates: string[];
  modifies: string[];
  deletes: string[];
  reuses: string[];
  conflicts: { path: string; classification: string }[];
  unresolved: string[];
  degradations: string[];
  permissionsRequired: string[];
  commandsProposed: { executable: string; argv: string[] }[];
  verificationPlanned: { name: string; command: { executable: string; argv: string[] } }[];
}

export interface CompilerPlanRequest {
  projectRoot: string;
  targetId: string;
}

export interface CompilerRunEvidenceRefs {
  planPath?: string;
  manifestPath?: string;
  evidencePath?: string;
  diagnosticsPath?: string;
}

export interface CompilerRunStatus {
  runId: string;
  status: 'queued' | 'validating' | 'lowering' | 'planning' | 'writing' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
  phase: 'validation' | 'lowering' | 'planning' | 'write' | 'verification' | 'idle';
  progress: number; // 0 to 100
  diagnostics: CompilerDiagnostic[];
  planHash?: string;
  startedAt: string;
  completedAt?: string;
  evidenceRefs?: CompilerRunEvidenceRefs;
}

export interface CompilerRunResult {
  runId: string;
  status: CompilerRunStatus;
}

export interface CompilerEvidence {
  runId: string;
  logs: string[];
  filesEmitted: string[];
  verificationOutput: string;
}
