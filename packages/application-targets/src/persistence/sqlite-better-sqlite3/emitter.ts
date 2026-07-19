import { ResolvedApplicationIR } from "@open-design/application-ir";
import { FileChange } from "@open-design/application-compiler";

export function emitSqliteBetterSqlite3(ir: ResolvedApplicationIR): FileChange[] {
  let migrationSql = `-- SQLite migration generated from Persistence IR
`;

  for (const agg of ir.persistence.aggregates) {
    const entity = ir.domain.entities.find(e => e.id === agg.rootEntity);
    if (entity) {
      migrationSql += `CREATE TABLE IF NOT EXISTS "${entity.id}" (\n`;
      const cols = entity.fields.map(f => {
        // Column names must be plain snake_case identifiers even when IR field
        // IDs use kebab-case (e.g. entry.created-at -> created_at).
        const colName = (f.id.split(".").pop() ?? f.id).replace(/[^a-zA-Z0-9_]+/g, "_");
        let sqlCol = `  "${colName}" `;
        if (f.type === "uuid" || f.type === "string") {
          sqlCol += "TEXT";
        } else if (f.type === "integer") {
          sqlCol += "INTEGER";
        } else {
          sqlCol += "TEXT";
        }
        if (f.id === entity.identity) {
          sqlCol += " PRIMARY KEY";
        }
        return sqlCol;
      });
      migrationSql += cols.join(",\n");
      migrationSql += `\n);\n\n`;
    }
  }

  // Create repository code
  let repoCode = `// sqlite-better-sqlite3 client and repository implementations
import Database from "better-sqlite3";

export function getDatabase(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}
`;

  return [
    {
      path: "src/server/persistence/migrations/0001_initial.sql",
      content: migrationSql,
      sourceIds: ir.persistence.aggregates.map(a => a.id),
    },
    {
      path: "src/server/persistence/db.ts",
      content: repoCode,
      sourceIds: [],
    }
  ];
}
