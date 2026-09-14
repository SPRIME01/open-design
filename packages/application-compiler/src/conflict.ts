import { createHash } from "crypto";
import { GeneratedFileManifest } from "./manifest.js";

export type ConflictClassification =
  | "CREATE"
  | "REUSE_IDENTICAL_MANUAL"
  | "CONFLICT_MANUAL_FILE"
  | "NO_CHANGE"
  | "CONFLICT_MODIFIED_GENERATED_FILE"
  | "MODIFY_GENERATED_FILE";

/**
 * How a compile/plan run resolves generated-file conflicts. This is the
 * projection config's existing `conflictPolicy` enum
 * (`packages/application-ir/src/schemas/projection-config.ts`) made a real
 * consumer; the same values are accepted as an explicit per-call option.
 *
 * Vocabulary mapping to the spec
 * (`.agents/specs/OPEN_DESIGN_APPLICATION_COMPILER_SPEC.md` §10.6 rules,
 * §13 recovery row "Generated-file conflict resolved through retain-manual,
 * regenerate, or explicitly approved force path", §14.4 `conflict_failure`):
 *
 * - `block` — spec default. Conflicts make the run terminal `conflicted`
 *   with zero writes (the host materializes nothing for the run).
 * - `plan-only` — spec "retain-manual". The manual file is kept
 *   byte-identical: excluded from the write set AND from the emitted
 *   manifest, so ownership is never taken and a later compile still sees
 *   the path as conflicting.
 * - `force` — spec "regenerate / explicitly approved force". The compiler
 *   (re)writes the file and reclaims manifest ownership with the new hash.
 *   Legal only as an explicit caller option or explicit config value —
 *   never as a default; the package trusts the explicit input, daemon-level
 *   approval binding lives outside the compiler package.
 */
export type ConflictResolution = "block" | "plan-only" | "force";

/**
 * Resolution precedence: an explicit per-call option beats the target
 * config's `conflictPolicy`; when neither is set, `block`. Every compile
 * and plan run resolves exactly one effective policy through this helper.
 */
export function resolveConflictResolution(
  explicit: ConflictResolution | undefined,
  configPolicy: ConflictResolution | undefined
): ConflictResolution {
  return explicit ?? configPolicy ?? "block";
}

/**
 * One entry of a plan's `conflicts` list: the disk-state classification
 * plus how the run's effective policy treated it (`block` = surfaced and
 * left unresolved, `plan-only` = retained manual bytes, `force` = reclaimed
 * by overwrite).
 */
export interface PlanConflictEntry {
  path: string;
  classification: ConflictClassification;
  resolution?: ConflictResolution;
}

// The single content hash used for both manifest entries and conflict
// classification; the two must agree or every regeneration misreads as a
// manual-edit conflict.
export function getFileHash(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

export function classifyPath(
  path: string,
  currentFileExists: boolean,
  currentFileContent: string | null,
  priorManifest: GeneratedFileManifest | null,
  proposedFileContent: string
): ConflictClassification {
  const prior = priorManifest?.files?.[path];

  if (!currentFileExists) {
    return "CREATE";
  }

  const currentContent = currentFileContent || "";
  const proposedHash = getFileHash(proposedFileContent);
  const currentHash = getFileHash(currentContent);

  if (!prior) {
    if (currentContent === proposedFileContent) {
      return "REUSE_IDENTICAL_MANUAL";
    }
    return "CONFLICT_MANUAL_FILE";
  }

  if (currentHash !== prior.hash) {
    if (currentContent === proposedFileContent) {
      return "NO_CHANGE";
    }
    return "CONFLICT_MODIFIED_GENERATED_FILE";
  }

  if (proposedHash === prior.hash) {
    return "NO_CHANGE";
  }

  return "MODIFY_GENERATED_FILE";
}
