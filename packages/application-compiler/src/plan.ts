import { createHash } from "crypto";

export interface CompilePlan {
  planVersion: string;
  runId: string;
  sourceHash: string;
  configHash: string;
  targetId: string;
  adapterVersions: Record<string, string>;
  creates: string[];
  modifies: string[];
  deletes: string[];
  reuses: string[];
  conflicts: any[];
  unresolved: string[];
  degradations: string[];
  permissionsRequired: string[];
  commandsProposed: { executable: string; argv: string[] }[];
  verificationPlanned: { name: string; command: { executable: string; argv: string[] } }[];
  estimatedOutputFiles: string[];
  planHash: string;
}

// The hash is computed from exactly these seven fields (each sorted), so the
// parameter type names them instead of demanding a full CompilePlan. Callers
// that hold a summary-shaped plan (e.g. planApplication) hash identically to
// compile() as long as these fields agree.
export type PlanHashInput = Pick<
  CompilePlan,
  | "creates"
  | "modifies"
  | "deletes"
  | "reuses"
  | "unresolved"
  | "degradations"
  | "permissionsRequired"
>;

export function buildPlanHash(plan: PlanHashInput): string {
  const data = JSON.stringify({
    creates: plan.creates.sort(),
    modifies: plan.modifies.sort(),
    deletes: plan.deletes.sort(),
    reuses: plan.reuses.sort(),
    unresolved: plan.unresolved.sort(),
    degradations: plan.degradations.sort(),
    permissionsRequired: plan.permissionsRequired.sort(),
  });
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}
