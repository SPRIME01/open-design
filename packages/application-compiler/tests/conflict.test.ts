import { describe, expect, it } from "vitest";
import { classifyPath } from "../src/conflict.js";
import { GeneratedFileManifest } from "../src/manifest.js";

describe("conflict classification tests", () => {
  const priorManifest = (): GeneratedFileManifest => ({
    schemaVersion: 1,
    targetId: "test-target",
    applicationId: "test-app",
    compilerVersion: "0.1.0",
    sourceHash: "",
    configHash: "",
    adapterVersions: { frontend: "test" },
    files: {
      "src/page.ts": { hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sourceIds: [] } // empty hash
    }
  });

  it("handles CREATE case when file does not exist", () => {
    expect(classifyPath("src/page.ts", false, null, null, "content")).toBe("CREATE");
  });

  it("handles CONFLICT_MANUAL_FILE when file exists but not in prior manifest", () => {
    expect(classifyPath("src/page.ts", true, "manual content", null, "proposed content")).toBe("CONFLICT_MANUAL_FILE");
  });

  it("handles CONFLICT_MODIFIED_GENERATED_FILE when file changed outside compiler", () => {
    expect(classifyPath("src/page.ts", true, "manually edited content", priorManifest(), "proposed content")).toBe("CONFLICT_MODIFIED_GENERATED_FILE");
  });

  it("handles NO_CHANGE when proposed content matches prior content", () => {
    expect(classifyPath("src/page.ts", true, "", priorManifest(), "")).toBe("NO_CHANGE");
  });
});
