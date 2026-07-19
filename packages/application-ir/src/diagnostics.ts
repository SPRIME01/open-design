export interface Diagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "advisory";
  phase: "validation" | "lowering" | "planning" | "write" | "verification";
  sourceFile?: string;
  pointer?: string;
  affectedIds?: string[];
  recommendedAction?: string;
}

export function createErrorDiagnostic(
  code: string,
  message: string,
  phase: "validation" | "lowering" | "planning" | "write" | "verification",
  extra?: Partial<Omit<Diagnostic, "code" | "message" | "severity" | "phase">>
): Diagnostic {
  return {
    code,
    message,
    severity: "error",
    phase,
    ...extra,
  };
}

export function createWarningDiagnostic(
  code: string,
  message: string,
  phase: "validation" | "lowering" | "planning" | "write" | "verification",
  extra?: Partial<Omit<Diagnostic, "code" | "message" | "severity" | "phase">>
): Diagnostic {
  return {
    code,
    message,
    severity: "warning",
    phase,
    ...extra,
  };
}
