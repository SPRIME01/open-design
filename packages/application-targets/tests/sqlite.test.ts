import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "@open-design/application-compiler";
import { registerAllBuiltInAdapters } from "../src/index.js";

const fixturesDir = path.join(import.meta.dirname, "../../application-ir/tests/fixtures");
const guestbookDir = path.join(import.meta.dirname, "../../../examples/guestbook");

// auth-settings is the richest Persistence IR fixture (uniqueness, indexes,
// soft-delete, optimistic concurrency, get+update repository); guestbook is
// the minimal one (get/list/insert, one index, hard delete, no uniqueness).
const sqliteFixtures = [
  { name: "auth-settings", dir: path.join(fixturesDir, "valid", "auth-settings") },
  { name: "guestbook", dir: guestbookDir },
] as const;

interface GeneratedFile {
  path: string;
  content: string;
}

function loadRaw(dir: string) {
  return {
    bundleRaw: JSON.parse(fs.readFileSync(path.join(dir, "application.ir.json"), "utf8")),
    domainRaw: JSON.parse(fs.readFileSync(path.join(dir, "ir", "domain.ir.json"), "utf8")),
    capabilitiesRaw: JSON.parse(fs.readFileSync(path.join(dir, "ir", "capabilities.ir.json"), "utf8")),
    boundaryRaw: JSON.parse(fs.readFileSync(path.join(dir, "ir", "boundary.ir.json"), "utf8")),
    persistenceRaw: JSON.parse(fs.readFileSync(path.join(dir, "ir", "persistence.ir.json"), "utf8")),
    frontendRaw: JSON.parse(fs.readFileSync(path.join(dir, "ir", "frontend.ir.json"), "utf8")),
  };
}

async function compileSqlite(dir: string): Promise<GeneratedFile[]> {
  const raw = loadRaw(dir);
  const config = {
    schemaVersion: 1,
    application: "application.ir.json",
    targets: [
      {
        id: "sqlite-target",
        adapter: "sqlite-better-sqlite3",
        mode: "scaffold" as const,
        outputRoot: "generated/sqlite-target",
        frontend: { adapter: "html-static" },
        persistence: { adapter: "sqlite-better-sqlite3" },
      },
    ],
  };

  const res = await compile(
    raw.bundleRaw,
    raw.domainRaw,
    raw.capabilitiesRaw,
    raw.boundaryRaw,
    raw.persistenceRaw,
    raw.frontendRaw,
    config,
    "sqlite-target"
  );

  expect(res.status, `sqlite compile diagnostics: ${JSON.stringify(res.diagnostics)}`).toBe("succeeded");
  return (res.fileSet?.files ?? []) as GeneratedFile[];
}

function file(files: GeneratedFile[], filePath: string): string {
  const content = files.find(f => f.path === filePath)?.content;
  expect(content, `generated file missing: ${filePath}`).toBeDefined();
  return content as string;
}

describe("sqlite persistence adapter tests", () => {
  beforeAll(() => {
    registerAllBuiltInAdapters();
  });

  it("compiles with sqlite-better-sqlite3 persistence successfully", async () => {
    const projectConsoleDir = path.join(fixturesDir, "valid", "project-console");

    const bundleRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "application.ir.json"), "utf8"));
    const domainRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "domain.ir.json"), "utf8"));
    const capabilitiesRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "capabilities.ir.json"), "utf8"));
    const boundaryRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "boundary.ir.json"), "utf8"));
    const persistenceRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "persistence.ir.json"), "utf8"));
    const frontendRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "frontend.ir.json"), "utf8"));

    const config = {
      schemaVersion: 1,
      application: "application.ir.json",
      targets: [
        {
          id: "sqlite-target",
          adapter: "sqlite-better-sqlite3",
          mode: "scaffold" as const,
          outputRoot: "generated/sqlite-target",
          frontend: { adapter: "html-static" },
          persistence: { adapter: "sqlite-better-sqlite3" }
        }
      ]
    };

    const res = await compile(
      bundleRaw,
      domainRaw,
      capabilitiesRaw,
      boundaryRaw,
      persistenceRaw,
      frontendRaw,
      config,
      "sqlite-target"
    );

    expect(res.status).toBe("succeeded");
    expect(res.fileSet?.files.some(f => f.path === "src/server/persistence/migrations/0001_initial.sql")).toBe(true);
  });

  it("generates an installable package.json pinned to the repository's better-sqlite3 major", async () => {
    const files = await compileSqlite(guestbookDir);
    const pkg = JSON.parse(file(files, "package.json"));

    expect(pkg.name).toBe("guestbook");
    expect(pkg.type).toBe("module");
    // Same major OpenDesign itself pins (apps/daemon): better-sqlite3 12.10.0,
    // @types/better-sqlite3 7.6.13.
    expect(pkg.dependencies["better-sqlite3"]).toBe("^12.10.0");
    expect(pkg.devDependencies["@types/better-sqlite3"]).toBe("^7.6.13");
  });

  it.each(sqliteFixtures.map(f => [f.name, f.dir] as const))(
    "generates a typed repository module per declared repository (%s)",
    async (name, dir) => {
      const files = await compileSqlite(dir);
      const persistence = loadRaw(dir).persistenceRaw as {
        aggregates: { id: string; rootEntity: string }[];
        repositories: { id: string; aggregate: string; operations: string[] }[];
      };

      for (const repository of persistence.repositories) {
        const aggregate = persistence.aggregates.find(a => a.id === repository.aggregate);
        expect(aggregate, `repository ${repository.id} references unknown aggregate`).toBeDefined();
        const repoCode = file(
          files,
          `src/server/persistence/${aggregate?.id}-repository.ts`
        );

        // The module is a factory over better-sqlite3 prepared statements
        // against the table derived from the aggregate's root entity.
        expect(repoCode).toContain("import type Database from");
        expect(repoCode).toContain(`FROM "${aggregate?.rootEntity}"`);
        for (const operation of repository.operations) {
          expect(repoCode).toContain(`    ${operation}(`);
        }
        for (const column of columnsFor(dir, aggregate?.rootEntity ?? "")) {
          expect(repoCode).toContain(`"${column}"`);
        }
      }
    }
  );

  it("guestbook repository orders list by the declared created-at index", async () => {
    const files = await compileSqlite(guestbookDir);
    const repoCode = file(files, "src/server/persistence/entry-repository.ts");
    const migration = file(files, "src/server/persistence/migrations/0001_initial.sql");

    expect(repoCode).toContain("export function createEntryRepository(db: Database)");
    expect(repoCode).toContain("export interface EntryRow");
    // Kebab-case field ids become snake_case columns in the generated SQL.
    expect(repoCode).toContain('INSERT INTO "entry" ("id", "author", "message", "created_at")');
    expect(repoCode).toContain('ORDER BY "created_at"');
    expect(repoCode).toContain("get(id: string): EntryRow | null");
    expect(repoCode).toContain("list(): EntryRow[]");
    expect(repoCode).toContain("insert(row: EntryRow): void");

    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "entry-created-at" ON "entry" ("created_at")');
  });

  it("auth-settings repository honors uniqueness, soft delete, and optimistic concurrency", async () => {
    const files = await compileSqlite(path.join(fixturesDir, "valid", "auth-settings"));
    const repoCode = file(files, "src/server/persistence/user-account-repository.ts");
    const migration = file(files, "src/server/persistence/migrations/0001_initial.sql");

    expect(repoCode).toContain("export function createUserAccountRepository(db: Database)");
    expect(repoCode).toContain("export interface UserAccountRow");
    expect(repoCode).toContain('"display_name"');
    // Soft delete: reads exclude tombstoned rows.
    expect(repoCode).toContain('AND "deleted_at" IS NULL');
    // Optimistic concurrency: the declared version column guards the UPDATE
    // and is incremented in place.
    expect(repoCode).toContain('"version" = "version" + 1');
    expect(repoCode).toContain('AND "version" = ?');
    expect(repoCode).toContain("update(row: UserAccountRow): number");

    // Declared uniqueness becomes a SQLite constraint so duplicate inserts
    // surface as constraint violations; declared indexes become real indexes.
    expect(migration).toContain('"email" TEXT UNIQUE');
    expect(migration).toContain('"deleted_at" TEXT');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "user-account-status" ON "user-account" ("status")');
  });

  it("recompiles byte-identical output", async () => {
    for (const fixture of sqliteFixtures) {
      const first = await compileSqlite(fixture.dir);
      const second = await compileSqlite(fixture.dir);

      expect(
        second.map(f => f.path),
        `${fixture.name}: file paths changed between compiles`
      ).toEqual(first.map(f => f.path));
      expect(
        second.map(f => f.content),
        `${fixture.name}: file contents changed between compiles`
      ).toEqual(first.map(f => f.content));
    }
  });
});

// Column names the migration derives for an entity's fields (snake_case of
// the field id's last segment), used for repository string-level assertions.
function columnsFor(dir: string, entityId: string): string[] {
  const domain = loadRaw(dir).domainRaw as {
    entities: { id: string; fields: { id: string }[] }[];
  };
  const entity = domain.entities.find(e => e.id === entityId);
  expect(entity, `fixture entity missing: ${entityId}`).toBeDefined();
  return (entity?.fields ?? []).map(f =>
    (f.id.split(".").pop() ?? f.id).replace(/[^a-zA-Z0-9_]+/g, "_")
  );
}
