import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
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

// --- generated migration runner (applyMigrations) ---

// Per-fixture driver configuration. auth-settings declares only get/update
// repository operations (no insert), so only guestbook exercises the
// repository round-trip here.
interface MigrationRunnerFixture {
  repositoryModule?: string;
  factoryName?: string;
  insertRow?: Record<string, string>;
}

const migrationRunnerFixtures: Record<string, MigrationRunnerFixture> = {
  guestbook: {
    repositoryModule: "./src/server/persistence/entry-repository.ts",
    factoryName: "createEntryRepository",
    insertRow: {
      id: "entry-r4-pkg",
      author: "Grace Hopper",
      message: "migration runner round-trip",
      created_at: "2026-09-13T09:30:00.000Z",
    },
  },
  "auth-settings": {},
};

function migrationRunnerFixture(name: string): MigrationRunnerFixture {
  const fixture = migrationRunnerFixtures[name];
  expect(fixture, `migration runner fixture config missing: ${name}`).toBeDefined();
  return fixture as MigrationRunnerFixture;
}

interface MigrationRunnerVerdict {
  firstRun: { version: string; fileName: string }[];
  row?: Record<string, unknown>;
  listed?: Record<string, unknown>[];
  versions: string[];
  tables: string[];
  secondRun: { version: string; fileName: string }[];
  inTransaction: boolean;
}

function migrationRunnerDriverSource(fixture: MigrationRunnerFixture): string {
  const lines = [
    `import { getDatabase, applyMigrations } from './src/server/persistence/db.ts';`,
  ];
  if (fixture.repositoryModule && fixture.factoryName) {
    lines.push(`import { ${fixture.factoryName} } from '${fixture.repositoryModule}';`);
  }
  lines.push(
    ``,
    `const db = getDatabase(':memory:');`,
    `const migrationsDir = process.argv[2];`,
    `const firstRun = applyMigrations(db, migrationsDir);`,
  );
  if (fixture.factoryName && fixture.insertRow) {
    lines.push(
      `const repository = ${fixture.factoryName}(db);`,
      `repository.insert(${JSON.stringify(fixture.insertRow)});`,
      `const row = repository.get(${JSON.stringify(fixture.insertRow.id)});`,
      `const listed = repository.list();`,
    );
  }
  lines.push(
    `const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);`,
    `const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);`,
    `const secondRun = applyMigrations(db, migrationsDir);`,
    fixture.insertRow
      ? `console.log(JSON.stringify({ firstRun, row, listed, versions, tables, secondRun, inTransaction: db.inTransaction }));`
      : `console.log(JSON.stringify({ firstRun, versions, tables, secondRun, inTransaction: db.inTransaction }));`,
    ``,
  );
  return lines.join("\n");
}

describe("generated migration runner (applyMigrations)", () => {
  const execFileAsync = promisify(execFile);
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    }
  });

  // Materializes the generated file set into a scratch project whose
  // node_modules links back to this package's own node_modules, so the
  // generated `import Database from "better-sqlite3"` resolves when the
  // driver runs under plain node (Node 24 strips the generated annotations
  // natively; the generated package.json provides "type": "module").
  async function materializeGenerated(files: GeneratedFile[]): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "od-sqlite-migrations-"));
    tempRoots.push(root);
    for (const generated of files) {
      const absolute = path.join(root, generated.path);
      await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
      await fs.promises.writeFile(absolute, generated.content, "utf8");
    }
    await fs.promises.symlink(
      path.join(import.meta.dirname, "..", "node_modules"),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
    return root;
  }

  async function runDriver(root: string): Promise<MigrationRunnerVerdict> {
    const driverFile = path.join(root, "migration-driver.ts");
    const migrationsDir = path.join(root, "src", "server", "persistence", "migrations");
    const { stdout, stderr } = await execFileAsync(process.execPath, [driverFile, migrationsDir], {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    expect(lastLine, `migration driver printed no verdict (stderr: ${stderr})`).toMatch(/^\{/);
    return JSON.parse(lastLine) as MigrationRunnerVerdict;
  }

  it.each(sqliteFixtures.map(f => [f.name, f.dir] as const))(
    "applies the generated migration to a fresh database, records the version, and skips it on re-apply (%s)",
    async (name, dir) => {
      const files = await compileSqlite(dir);
      const root = await materializeGenerated(files);
      const runner = migrationRunnerFixture(name);
      await fs.promises.writeFile(
        path.join(root, "migration-driver.ts"),
        migrationRunnerDriverSource(runner),
        "utf8"
      );
      const verdict = await runDriver(root);

      // First apply: the generated initial migration commits and its version
      // is recorded in schema_migrations.
      expect(verdict.firstRun).toEqual([{ version: "0001_initial", fileName: "0001_initial.sql" }]);
      expect(verdict.versions).toEqual(["0001_initial"]);
      expect(verdict.tables).toEqual(
        expect.arrayContaining(["schema_migrations", name === "guestbook" ? "entry" : "user-account"])
      );

      // Round-trip where the IR declares an insert operation (guestbook).
      const insertRow = runner.insertRow;
      if (insertRow) {
        expect(verdict.row).toEqual(insertRow);
        expect(verdict.listed).toEqual([insertRow]);
      }

      // Second apply: already-applied files are skipped — a no-op.
      expect(verdict.secondRun).toEqual([]);
      expect(verdict.inTransaction).toBe(false);
    }
  );
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
