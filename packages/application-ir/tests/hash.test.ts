import { describe, expect, it } from "vitest";
import { computeSemanticHash } from "../src/hash.js";

describe("deterministic semantic hashing tests", () => {
  it("produces identical hashes for objects with different key order", () => {
    const objA = { b: 2, a: 1, generatedAt: "2026-07-16" };
    const objB = { a: 1, b: 2, generatedAt: "2026-07-15" }; // generatedAt is excluded
    expect(computeSemanticHash(objA)).toBe(computeSemanticHash(objB));
  });

  it("produces different hashes for different content", () => {
    const objA = { a: 1 };
    const objB = { a: 2 };
    expect(computeSemanticHash(objA)).not.toBe(computeSemanticHash(objB));
  });
});
