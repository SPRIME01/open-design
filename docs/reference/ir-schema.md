# Reference: Application IR Schema (`application.ir.json`)

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Compiler Guide:** [`docs/subsystems/compiler.md`](file:///home/sprime01/projects/open-design/docs/subsystems/compiler.md) · **Implementation:** [`packages/application-ir/src/schemas/`](file:///home/sprime01/projects/open-design/packages/application-ir/src/schemas/)

This document specifies the formal schema, properties, types, and validation rules for the Application Intermediate Representation (`application.ir.json`).

---

## 1. Top-Level Bundle Structure

An Application IR project can be defined as a single `application.ir.json` file or split modularly across an `ir/` subdirectory (`domain.ir.json`, `capabilities.ir.json`, `boundary.ir.json`, `persistence.ir.json`, `frontend.ir.json`).

```json
{
  "$schema": "https://open-design.dev/schemas/application.ir.v1.json",
  "schemaVersion": 1,
  "applicationId": "guestbook-app",
  "name": "Guestbook Application",
  "description": "A collaborative public guestbook with message posting and moderation.",
  "domain": { ... },
  "capabilities": { ... },
  "boundary": { ... },
  "persistence": { ... },
  "frontend": { ... }
}
```

---

## 2. Domain Model (`domain`)

Defines domain entities, value objects, and scalar/composite types:

```json
"domain": {
  "entities": [
    {
      "id": "Entry",
      "name": "GuestbookEntry",
      "description": "A single public guestbook posting.",
      "fields": [
        { "name": "id", "type": "string", "primaryKey": true, "generated": "uuid" },
        { "name": "authorName", "type": "string", "required": true, "maxLength": 50 },
        { "name": "message", "type": "string", "required": true, "maxLength": 500 },
        { "name": "createdAt", "type": "datetime", "required": true, "default": "now" }
      ]
    }
  ]
}
```

---

## 3. Capabilities (`capabilities`)

Defines application operations (commands, queries, and events):

```json
"capabilities": {
  "commands": [
    {
      "id": "CreateEntry",
      "name": "Create Guestbook Entry",
      "inputs": [
        { "name": "authorName", "type": "string", "required": true },
        { "name": "message", "type": "string", "required": true }
      ],
      "emits": ["EntryCreated"],
      "effects": [{ "entity": "Entry", "action": "create" }]
    }
  ],
  "queries": [
    {
      "id": "ListEntries",
      "name": "List Guestbook Entries",
      "returns": { "type": "list", "element": "Entry" },
      "orderBy": [{ "field": "createdAt", "direction": "desc" }]
    }
  ]
}
```

---

## 4. Boundaries (`boundary`)

Maps application capabilities to network transports and authorization requirements:

```json
"boundary": {
  "routes": [
    {
      "path": "/api/entries",
      "method": "POST",
      "capability": "CreateEntry",
      "auth": { "policy": "public" }
    },
    {
      "path": "/api/entries",
      "method": "GET",
      "capability": "ListEntries",
      "auth": { "policy": "public" }
    }
  ]
}
```

---

## 5. Persistence (`persistence`)

Defines the database schema, relational tables, foreign keys, and indexes:

```json
"persistence": {
  "tables": [
    {
      "name": "entries",
      "entity": "Entry",
      "columns": [
        { "name": "id", "type": "TEXT", "primaryKey": true },
        { "name": "author_name", "type": "TEXT", "nullable": false },
        { "name": "message", "type": "TEXT", "nullable": false },
        { "name": "created_at", "type": "TIMESTAMP", "nullable": false }
      ],
      "indexes": [
        { "name": "idx_entries_created_at", "columns": ["created_at"] }
      ]
    }
  ]
}
```

---

## 6. Frontend (`frontend`)

Defines screens, component hierarchies, slots, and interactive flows:

```json
"frontend": {
  "screens": [
    {
      "id": "HomeScreen",
      "route": "/",
      "title": "Public Guestbook",
      "layout": "default",
      "components": [
        {
          "id": "FormSection",
          "component": "GuestbookForm",
          "bindCommand": "CreateEntry"
        },
        {
          "id": "ListSection",
          "component": "GuestbookList",
          "bindQuery": "ListEntries"
        }
      ]
    }
  ]
}
```

---

## 7. Projection Configuration (`projection.config.json`)

The target configuration file mapping the IR to output directories and compiler settings:

```json
{
  "targets": [
    {
      "id": "react-vite",
      "adapter": "react-vite",
      "outDir": "generated/react-vite",
      "conflictPolicy": "block"
    },
    {
      "id": "sqlite-better-sqlite3",
      "adapter": "sqlite-better-sqlite3",
      "outDir": "generated/sqlite-better-sqlite3",
      "conflictPolicy": "block"
    }
  ]
}
```

- `conflictPolicy`: `block` (default), `plan-only`, or `force`.
- `outDir`: Relative path where projected files will be written.

---

## 8. Source Trail

- [`packages/application-ir/src/schemas/bundle.ts`](file:///home/sprime01/projects/open-design/packages/application-ir/src/schemas/bundle.ts) — Bundle schema.
- [`packages/application-ir/src/schemas/domain.ts`](file:///home/sprime01/projects/open-design/packages/application-ir/src/schemas/domain.ts) — Domain schema.
- [`packages/application-ir/src/schemas/capabilities.ts`](file:///home/sprime01/projects/open-design/packages/application-ir/src/schemas/capabilities.ts) — Capability schema.
- [`packages/application-ir/src/schemas/boundary.ts`](file:///home/sprime01/projects/open-design/packages/application-ir/src/schemas/boundary.ts) — Boundary schema.
- [`packages/application-ir/src/schemas/persistence.ts`](file:///home/sprime01/projects/open-design/packages/application-ir/src/schemas/persistence.ts) — Persistence schema.
- [`packages/application-ir/src/schemas/frontend.ts`](file:///home/sprime01/projects/open-design/packages/application-ir/src/schemas/frontend.ts) — Frontend schema.
- [`packages/application-ir/src/schemas/projection-config.ts`](file:///home/sprime01/projects/open-design/packages/application-ir/src/schemas/projection-config.ts) — Target configuration schema.
