import { createHash } from "crypto";

export function deterministicStringify(val: any): string {
  if (val === null || val === undefined) {
    return "null";
  }
  if (Array.isArray(val)) {
    return "[" + val.map(deterministicStringify).join(",") + "]";
  }
  if (typeof val === "object") {
    const keys = Object.keys(val).sort();
    const parts = keys.map((key) => {
      // Exclude run-time transient metadata like generatedAt
      if (key === "generatedAt") {
        return "";
      }
      return JSON.stringify(key) + ":" + deterministicStringify(val[key]);
    }).filter(Boolean);
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(val);
}

export function computeSemanticHash(val: any): string {
  const serialized = deterministicStringify(val);
  return "sha256:" + createHash("sha256").update(serialized).digest("hex");
}
