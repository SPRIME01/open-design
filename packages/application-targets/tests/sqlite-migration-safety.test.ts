import { describe, expect, it } from "vitest";
import { classifyPersistenceChange } from "../src/persistence/sqlite-better-sqlite3/migration-planner.js";
import { PersistenceIR } from "@open-design/application-ir";

describe("SQLite migration safety tests", () => {
  const basePersistence = (): PersistenceIR => ({
    schemaVersion: "1.0.0",
    applicationId: "test-app",
    aggregates: [{ id: "project", rootEntity: "project", transactionBoundary: true }],
    repositories: [],
    relations: [],
    indexes: [],
    uniqueness: [],
    retention: [],
    deletionPolicies: [],
    concurrency: [],
    migrationIntent: []
  });

  it("permits initial migration as SAFE_ADDITIVE", () => {
    const next = basePersistence();
    const { diffs, diagnostics } = classifyPersistenceChange(null, next);
    expect(diffs[0]!.type).toBe("SAFE_ADDITIVE");
    expect(diagnostics.length).toBe(0);
  });

  it("detects destructive changes when aggregate is removed", () => {
    const prev = basePersistence();
    const next = basePersistence();
    next.aggregates = []; // dropped project aggregate

    const { diffs, diagnostics } = classifyPersistenceChange(prev, next);
    expect(diffs.some(d => d.type === "DESTRUCTIVE_REQUIRES_DECISION")).toBe(true);
    expect(diagnostics.some(d => d.code === "unsafe_migration_error")).toBe(true);
  });
});
