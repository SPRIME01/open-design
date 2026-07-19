import { describe, expect, it } from "vitest";
import { normalizeId, resolveIdCollisions } from "../src/normalize.js";

describe("ID normalization tests", () => {
  it("normalizes human-readable IDs according to spec §7.4 rules", () => {
    expect(normalizeId("Project Console!", "component")).toBe("project-console");
    expect(normalizeId("my_awesome/route.screen", "screen")).toBe("my_awesome/route.screen");
    expect(normalizeId("  leading-and-trailing--", "node")).toBe("leading-and-trailing");
    expect(normalizeId("---", "node", "semantic-path-example")).toBe("node--34d9da43"); // empty ID fallback
  });

  it("resolves collisions by appending a hash", () => {
    const list = [
      { unnormalized: "My Button", kind: "button", semanticPath: "path.a" },
      { unnormalized: "My Button", kind: "button", semanticPath: "path.b" },
    ];
    const results = resolveIdCollisions(list);
    expect(results[0]).toBe("my-button");
    expect(results[1]).toBe("my-button--427d8eba");
  });
});
