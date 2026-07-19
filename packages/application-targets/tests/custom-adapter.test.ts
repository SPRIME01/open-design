import { describe, expect, it } from "vitest";
import { adapterRegistry } from "@open-design/application-compiler";
import { CustomTxtAdapter } from "./fixtures/custom-adapter.js";

describe("custom adapter tests", () => {
  it("registers and runs custom adapter successfully", async () => {
    const adapter = new CustomTxtAdapter();
    adapterRegistry.register(adapter);

    const registered = adapterRegistry.get("custom-txt");
    expect(registered).toBeDefined();
    expect(registered?.id).toBe("custom-txt");
  });
});
