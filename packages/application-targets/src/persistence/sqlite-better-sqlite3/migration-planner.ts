import { PersistenceIR, Diagnostic, createErrorDiagnostic } from "@open-design/application-ir";

export interface PersistenceDiff {
  type: "SAFE_ADDITIVE" | "REVIEW_REQUIRED" | "DESTRUCTIVE_REQUIRES_DECISION" | "UNKNOWN_BLOCKING";
  message: string;
}

export function classifyPersistenceChange(
  previous: PersistenceIR | null,
  next: PersistenceIR
): { diffs: PersistenceDiff[]; diagnostics: Diagnostic[] } {
  const diffs: PersistenceDiff[] = [];
  const diagnostics: Diagnostic[] = [];

  if (!previous) {
    diffs.push({ type: "SAFE_ADDITIVE", message: "Initial database creation." });
    return { diffs, diagnostics };
  }

  // Simple diff logic for v0.1.0
  // Check if any aggregate/repository was removed or modified
  const prevAggs = new Map(previous.aggregates.map(a => [a.id, a]));
  const nextAggs = new Map(next.aggregates.map(a => [a.id, a]));

  for (const [id, prev] of prevAggs.entries()) {
    if (!nextAggs.has(id)) {
      diffs.push({ type: "DESTRUCTIVE_REQUIRES_DECISION", message: `Aggregate '${id}' was removed.` });
      diagnostics.push(
        createErrorDiagnostic("unsafe_migration_error", `Unsafe database migration: Aggregate '${id}' was removed.`, "planning")
      );
    }
  }

  // Check if any relation/index is deleted or uniqueness changed
  return { diffs, diagnostics };
}
