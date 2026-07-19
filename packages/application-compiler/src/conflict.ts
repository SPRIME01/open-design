import { createHash } from "crypto";
import { GeneratedFileManifest } from "./manifest.js";

export type ConflictClassification =
  | "CREATE"
  | "REUSE_IDENTICAL_MANUAL"
  | "CONFLICT_MANUAL_FILE"
  | "NO_CHANGE"
  | "CONFLICT_MODIFIED_GENERATED_FILE"
  | "MODIFY_GENERATED_FILE";

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
