import { ResolvedApplicationIR } from "@open-design/application-ir";
import { FileChange } from "@open-design/application-compiler";

// Dependency floors mirror this repository's own pins (apps/daemon pins
// better-sqlite3 12.10.0 and @types/better-sqlite3 7.6.13): generated output
// must install in the same major OpenDesign itself runs against. Keep these
// literals in lockstep with apps/daemon/package.json when that pin moves.
const BETTER_SQLITE3_RANGE = "^12.10.0";
const TYPES_BETTER_SQLITE3_RANGE = "^7.6.13";

// Repository operation kinds the emitter knows how to implement. The
// Persistence IR schema allows arbitrary operation strings; kinds outside
// this set (and degenerate cases like an update with no assignable columns)
// are skipped with an inline note in the generated module.
const SUPPORTED_OPERATIONS = new Set(["get", "list", "insert", "update", "delete"]);

const SOFT_DELETE_COLUMN = "deleted_at";

interface EntityColumn {
  name: string;
  irType: string;
  isIdentity: boolean;
}

interface EntityModel {
  entityId: string;
  columns: EntityColumn[];
  identityColumn: string;
  softDelete: boolean;
  inlineUniqueColumns: string[];
  uniqueColumnGroups: string[][];
  indexes: { id: string; columns: string[]; unique: boolean }[];
}

// Column names must be plain snake_case identifiers even when IR field
// IDs use kebab-case (e.g. entry.created-at -> created_at). A leading
// underscore keeps digit-starting segments usable as TS identifiers too.
function toColumnName(fieldId: string): string {
  const column = (fieldId.split(".").pop() ?? fieldId).replace(/[^a-zA-Z0-9_]+/g, "_");
  return /^[0-9]/.test(column) ? `_${column}` : column;
}

// Index/uniqueness/concurrency field references use loose casing against
// domain field ids ("createdAt" vs the column "created_at"), so references
// resolve on a case- and separator-insensitive key of the column name.
function fieldRefKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveFieldColumns(columns: EntityColumn[], refs: string[]): string[] {
  const resolved: string[] = [];
  for (const ref of refs) {
    const key = fieldRefKey(ref);
    const column = columns.find(c => fieldRefKey(c.name) === key);
    if (!column) {
      return [];
    }
    resolved.push(column.name);
  }
  return resolved;
}

function sqlColumnType(irType: string): string {
  if (irType === "integer" || irType === "boolean") {
    return "INTEGER";
  }
  // uuid/string values are TEXT; timestamps are stored as ISO-8601 TEXT;
  // enum-typed fields persist as their string values.
  return "TEXT";
}

function tsColumnType(irType: string): string {
  if (irType === "integer") {
    return "number";
  }
  if (irType === "boolean") {
    return "boolean";
  }
  return "string";
}

function pascalCase(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function quoteColumn(name: string): string {
  return `"${name}"`;
}

// Boolean columns persist as 0/1 integers; every other type binds directly.
function sqlParam(expr: string, irType: string): string {
  return irType === "boolean" ? `(${expr} ? 1 : 0)` : expr;
}

function buildEntityModel(ir: ResolvedApplicationIR, entityId: string): EntityModel | null {
  const entity = ir.domain.entities.find(e => e.id === entityId);
  if (!entity) {
    return null;
  }
  const columns: EntityColumn[] = entity.fields.map(f => ({
    name: toColumnName(f.id),
    irType: f.type,
    isIdentity: f.id === entity.identity,
  }));
  const identity = columns.find(c => c.isIdentity) ?? columns[0];
  if (!identity) {
    return null;
  }

  const inlineUniqueColumns: string[] = [];
  const uniqueColumnGroups: string[][] = [];
  for (const unique of ir.persistence.uniqueness.filter(u => u.entity === entityId)) {
    const cols = resolveFieldColumns(columns, unique.fields);
    const single = cols.length === 1 ? cols[0] : undefined;
    if (single !== undefined && single !== identity.name) {
      inlineUniqueColumns.push(single);
    } else if (cols.length > 1) {
      uniqueColumnGroups.push(cols);
    }
  }

  return {
    entityId,
    columns,
    identityColumn: identity.name,
    softDelete: ir.persistence.deletionPolicies.some(
      p => p.entity === entityId && p.mode === "soft",
    ),
    inlineUniqueColumns,
    uniqueColumnGroups,
    indexes: ir.persistence.indexes
      .filter(i => i.entity === entityId)
      .map(i => ({ id: i.id, columns: resolveFieldColumns(columns, i.fields), unique: i.unique }))
      .filter(i => i.columns.length > 0),
  };
}

function emitMigrationSql(ir: ResolvedApplicationIR): string {
  let migrationSql = `-- SQLite migration generated from Persistence IR\n`;

  for (const agg of ir.persistence.aggregates) {
    const model = buildEntityModel(ir, agg.rootEntity);
    if (!model) {
      continue;
    }

    const columnDefs = model.columns.map(c => {
      let def = `  ${quoteColumn(c.name)} ${sqlColumnType(c.irType)}`;
      if (c.isIdentity) {
        def += " PRIMARY KEY";
      } else if (model.inlineUniqueColumns.includes(c.name)) {
        // Declared uniqueness becomes a SQLite constraint so duplicate
        // inserts surface as constraint violations from the driver.
        def += " UNIQUE";
      }
      return def;
    });
    if (model.softDelete) {
      columnDefs.push(`  ${quoteColumn(SOFT_DELETE_COLUMN)} TEXT`);
    }
    for (const group of model.uniqueColumnGroups) {
      columnDefs.push(`  UNIQUE (${group.map(quoteColumn).join(", ")})`);
    }

    migrationSql += `CREATE TABLE IF NOT EXISTS ${quoteColumn(model.entityId)} (\n`;
    migrationSql += `${columnDefs.join(",\n")}\n);\n\n`;

    for (const index of model.indexes) {
      const cols = index.columns.map(quoteColumn).join(", ");
      migrationSql += `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteColumn(index.id)} ON ${quoteColumn(model.entityId)} (${cols});\n\n`;
    }
  }

  return migrationSql;
}

function emitDbModule(): string {
  return `// sqlite-better-sqlite3 database client and migration runner.
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function getDatabase(dbPath: string) {
  const db = new Database(dbPath);
  // PRAGMA foreign_keys is a connection-level toggle and a no-op inside a
  // transaction, so it is set here — outside any transaction — before any
  // migration or query runs.
  db.pragma("foreign_keys = ON");
  return db;
}

export interface AppliedMigration {
  version: string;
  fileName: string;
}

// SQLite DDL is transactional: CREATE/ALTER/DROP executed between BEGIN and
// COMMIT rolls back exactly like DML. applyMigrations relies on that — each
// migration file runs inside ONE transaction together with the INSERT that
// records its version in schema_migrations, so a failure partway through a
// file (bad SQL in a later statement, a constraint violation mid-batch)
// rolls the whole file back: the previous schema AND data stay intact and
// nothing is recorded for the failed version. The error propagates to the
// caller; already-applied files are skipped, so repeat calls are no-ops.
export function applyMigrations(db: Database.Database, migrationsDir: string): AppliedMigration[] {
  db.exec(\`CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)\`);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map(
      row => row.version,
    ),
  );

  const migrationFiles = readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
    .map(entry => entry.name)
    .sort();

  const appliedNow: AppliedMigration[] = [];
  for (const fileName of migrationFiles) {
    const version = fileName.replace(/\\.sql$/, "");
    if (applied.has(version)) {
      continue;
    }
    const sql = readFileSync(join(migrationsDir, fileName), "utf8");
    // One transaction per migration file: statements plus the version record
    // commit together or roll back together.
    const applyFile = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, file_name) VALUES (?, ?)").run(version, fileName);
    });
    applyFile();
    appliedNow.push({ version, fileName });
  }
  return appliedNow;
}
`;
}

interface RepositoryModel {
  aggregateId: string;
  entityId: string;
  rowType: string;
  factoryName: string;
  filePath: string;
  content: string;
}

function emitRepositoryModule(
  ir: ResolvedApplicationIR,
  repository: { id: string; aggregate: string; operations: string[] },
): RepositoryModel | null {
  const aggregate = ir.persistence.aggregates.find(a => a.id === repository.aggregate);
  if (!aggregate) {
    return null;
  }
  const model = buildEntityModel(ir, aggregate.rootEntity);
  if (!model) {
    return null;
  }

  const name = pascalCase(aggregate.id);
  const rowType = `${name}Row`;
  const factoryName = `create${name}Repository`;
  const table = quoteColumn(model.entityId);
  const identity = model.identityColumn;
  const columnList = model.columns.map(c => quoteColumn(c.name)).join(", ");
  const hasBooleans = model.columns.some(c => c.irType === "boolean");
  const softClause = model.softDelete ? ` AND ${quoteColumn(SOFT_DELETE_COLUMN)} IS NULL` : "";
  const softWhere = model.softDelete ? ` WHERE ${quoteColumn(SOFT_DELETE_COLUMN)} IS NULL` : "";

  // Optimistic concurrency: the declared version column guards the UPDATE
  // and is incremented in place; a 0-changes result signals a conflict.
  const concurrency = ir.persistence.concurrency.find(
    c => c.aggregate === aggregate.id && c.strategy === "optimistic",
  );
  const versionColumn = concurrency
    ? resolveFieldColumns(model.columns, [concurrency.versionField])[0]
    : undefined;

  // List ordering follows the first declared non-unique index whose fields
  // resolve to columns; otherwise rows order by the identity column.
  const orderColumns = model.indexes.find(i => !i.unique)?.columns ?? [identity];

  const updatable = model.columns.filter(c => !c.isIdentity && c.name !== versionColumn);
  const skipped: string[] = [];
  const implemented: string[] = [];
  for (const op of repository.operations) {
    if (!SUPPORTED_OPERATIONS.has(op)) {
      skipped.push(op);
      continue;
    }
    if (op === "update" && updatable.length === 0) {
      skipped.push(op);
      continue;
    }
    implemented.push(op);
  }

  const lines: string[] = [];
  lines.push(`// Repository for aggregate "${aggregate.id}" — generated from the Persistence IR.`);
  if (skipped.length > 0) {
    lines.push(`// Skipped operations (no sqlite emitter support): ${skipped.map(op => `"${op}"`).join(", ")}.`);
  }
  lines.push(`import type Database from "better-sqlite3";`);
  lines.push(``);
  lines.push(`export interface ${rowType} {`);
  for (const c of model.columns) {
    lines.push(`  ${c.name}: ${tsColumnType(c.irType)};`);
  }
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function ${factoryName}(db: Database) {`);

  const methods: string[] = [];
  const needsToRow = hasBooleans && (implemented.includes("get") || implemented.includes("list"));

  if (implemented.includes("get")) {
    lines.push(`  const getStmt = db.prepare(`);
    lines.push(`    'SELECT ${columnList} FROM ${table} WHERE ${quoteColumn(identity)} = ?${softClause}'`);
    lines.push(`  );`);
    if (hasBooleans) {
      methods.push([
        `    get(${identity}: string): ${rowType} | null {`,
        `      const record = getStmt.get(${identity});`,
        `      return record ? toRow(record) : null;`,
        `    },`,
      ].join("\n"));
    } else {
      methods.push([
        `    get(${identity}: string): ${rowType} | null {`,
        `      return (getStmt.get(${identity}) as ${rowType} | undefined) ?? null;`,
        `    },`,
      ].join("\n"));
    }
  }

  if (implemented.includes("list")) {
    lines.push(`  const listStmt = db.prepare(`);
    lines.push(`    'SELECT ${columnList} FROM ${table}${softWhere} ORDER BY ${orderColumns.map(quoteColumn).join(", ")}'`);
    lines.push(`  );`);
    if (hasBooleans) {
      methods.push([
        `    list(): ${rowType}[] {`,
        `      return listStmt.all().map(toRow);`,
        `    },`,
      ].join("\n"));
    } else {
      methods.push([
        `    list(): ${rowType}[] {`,
        `      return listStmt.all() as ${rowType}[];`,
        `    },`,
      ].join("\n"));
    }
  }

  if (implemented.includes("insert")) {
    const params = model.columns.map(c => sqlParam(`row.${c.name}`, c.irType)).join(", ");
    lines.push(`  const insertStmt = db.prepare(`);
    lines.push(`    'INSERT INTO ${table} (${columnList}) VALUES (${model.columns.map(() => "?").join(", ")})'`);
    lines.push(`  );`);
    if (model.inlineUniqueColumns.length > 0 || model.uniqueColumnGroups.length > 0) {
      methods.push(
        [
          `    // Declared uniqueness surfaces as the SQLite UNIQUE constraint violation thrown here.`,
          `    insert(row: ${rowType}): void {`,
          `      insertStmt.run(${params});`,
          `    },`,
        ].join("\n"),
      );
    } else {
      methods.push(
        [
          `    insert(row: ${rowType}): void {`,
          `      insertStmt.run(${params});`,
          `    },`,
        ].join("\n"),
      );
    }
  }

  if (implemented.includes("update")) {
    const setParts = updatable.map(c => `${quoteColumn(c.name)} = ?`);
    const whereParts = [`${quoteColumn(identity)} = ?`];
    const runParams = updatable.map(c => sqlParam(`row.${c.name}`, c.irType));
    if (versionColumn) {
      setParts.push(`${quoteColumn(versionColumn)} = ${quoteColumn(versionColumn)} + 1`);
      whereParts.push(`${quoteColumn(versionColumn)} = ?`);
      runParams.push(`row.${identity}`, `row.${versionColumn}`);
    } else {
      runParams.push(`row.${identity}`);
    }
    if (model.softDelete) {
      whereParts.push(`${quoteColumn(SOFT_DELETE_COLUMN)} IS NULL`);
    }
    lines.push(`  const updateStmt = db.prepare(`);
    lines.push(`    'UPDATE ${table} SET ${setParts.join(", ")} WHERE ${whereParts.join(" AND ")}'`);
    lines.push(`  );`);
    methods.push([
      `    update(row: ${rowType}): number {`,
      `      return updateStmt.run(${runParams.join(", ")}).changes;`,
      `    },`,
    ].join("\n"));
  }

  if (implemented.includes("delete")) {
    if (model.softDelete) {
      lines.push(`  const deleteStmt = db.prepare(`);
      lines.push(`    'UPDATE ${table} SET ${quoteColumn(SOFT_DELETE_COLUMN)} = ? WHERE ${quoteColumn(identity)} = ? AND ${quoteColumn(SOFT_DELETE_COLUMN)} IS NULL'`);
      lines.push(`  );`);
      methods.push([
        `    delete(${identity}: string): number {`,
        `      return deleteStmt.run(new Date().toISOString(), ${identity}).changes;`,
        `    },`,
      ].join("\n"));
    } else {
      lines.push(`  const deleteStmt = db.prepare(`);
      lines.push(`    'DELETE FROM ${table} WHERE ${quoteColumn(identity)} = ?'`);
      lines.push(`  );`);
      methods.push([
        `    delete(${identity}: string): number {`,
        `      return deleteStmt.run(${identity}).changes;`,
        `    },`,
      ].join("\n"));
    }
  }

  if (needsToRow) {
    lines.push(emitToRowHelper(rowType, model));
  }
  lines.push(``);
  lines.push(`  return {`);
  for (const method of methods) {
    lines.push(method);
  }
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);

  return {
    aggregateId: aggregate.id,
    entityId: model.entityId,
    rowType,
    factoryName,
    filePath: `src/server/persistence/${aggregate.id.replace(/\//g, "-")}-repository.ts`,
    content: lines.join("\n"),
  };
}

// Boolean columns read back as 0/1; remap them to booleans for the row type.
function emitToRowHelper(rowType: string, model: EntityModel): string {
  const fields = model.columns
    .map(c =>
      c.irType === "boolean"
        ? `    ${c.name}: row.${c.name} === 1,`
        : `    ${c.name}: row.${c.name} as ${tsColumnType(c.irType)},`,
    )
    .join("\n");
  return [
    `  function toRow(record: unknown): ${rowType} {`,
    `    const row = record as Record<string, unknown>;`,
    `    return {`,
    fields,
    `    };`,
    `  }`,
  ].join("\n");
}

export function emitSqliteBetterSqlite3(ir: ResolvedApplicationIR): FileChange[] {
  const packageJson = {
    name: ir.bundle.applicationId,
    private: true,
    version: "0.1.0",
    type: "module",
    dependencies: {
      "better-sqlite3": BETTER_SQLITE3_RANGE,
    },
    devDependencies: {
      "@types/better-sqlite3": TYPES_BETTER_SQLITE3_RANGE,
    },
  };

  const files: FileChange[] = [
    {
      path: "package.json",
      content: JSON.stringify(packageJson, null, 2),
      sourceIds: [ir.bundle.applicationId],
    },
    {
      path: "src/server/persistence/migrations/0001_initial.sql",
      content: emitMigrationSql(ir),
      sourceIds: ir.persistence.aggregates.map(a => a.id),
    },
    {
      path: "src/server/persistence/db.ts",
      content: emitDbModule(),
      sourceIds: [],
    },
  ];

  for (const repository of ir.persistence.repositories) {
    const module = emitRepositoryModule(ir, repository);
    if (module) {
      files.push({
        path: module.filePath,
        content: module.content,
        sourceIds: [repository.id],
      });
    }
  }

  return files;
}
