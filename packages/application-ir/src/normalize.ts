import { createHash } from "crypto";

export function getHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function normalizeId(id: string, kind: string, semanticPath?: string): string {
  // NFKD normalization, lowercase
  let normalized = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, ""); // remove combining marks

  // Replace each run outside [a-z0-9._/-] with -
  normalized = normalized.replace(/[^a-z0-9._/-]+/g, "-");

  // Collapse repeated -
  normalized = normalized.replace(/-+/g, "-");

  // Trim separators from start and end
  normalized = normalized.replace(/^[._/-]+|[._/-]+$/g, "");

  if (!normalized) {
    const path = semanticPath || id || kind;
    return `${kind.toLowerCase()}--${getHash(path)}`;
  }

  return normalized;
}

export function resolveIdCollisions(ids: { unnormalized: string; kind: string; semanticPath: string }[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const entry of ids) {
    let norm = normalizeId(entry.unnormalized, entry.kind, entry.semanticPath);
    if (seen.has(norm)) {
      norm = `${norm}--${getHash(entry.semanticPath)}`;
    }
    seen.add(norm);
    results.push(norm);
  }

  return results;
}
