# Tutorial: Compiling Your First Application from IR

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Compiler Guide:** [`docs/subsystems/compiler.md`](file:///home/sprime01/projects/open-design/docs/subsystems/compiler.md) · **Reference:** [`docs/reference/ir-schema.md`](file:///home/sprime01/projects/open-design/docs/reference/ir-schema.md)

This hands-on tutorial guides you through creating, planning, compiling, and verifying your first framework-native application using the Open Design compiler.

---

## Prerequisites

Before beginning, ensure you have installed:
- Node.js `~24`
- pnpm `10.33.2` (via Corepack or `npm install -g pnpm@10.33.2`)
- Open Design repository cloned and dependencies installed (`pnpm install`)

---

## Goal

You will scaffold a guestbook application defined in `application.ir.json`, validate its schemas, generate a compile plan, project it into a complete React 18 + Vite 5 application, and run build verification.

---

## Step 1: Start the Local Daemon

Open Design's compilation service runs inside the daemon. In your terminal, start the daemon:

```bash
pnpm tools-dev start daemon
```

**Expected Result:**
```text
[tools-dev] Daemon sidecar started on port 7456 (pid: 12345)
[tools-dev] Health probe passed: http://127.0.0.1:7456/api/health
```

---

## Step 2: Scaffold a Starter Application Project

Create a new directory for your project and initialize an application IR bundle:

```bash
mkdir -p ./my-guestbook
od app init --project ./my-guestbook --template crud
```

**Expected Result:**
Open Design scaffolds the starter IR bundle:
```text
my-guestbook/
├── application.ir.json     ← Top-level IR bundle
├── ir/
│   ├── domain.ir.json      ← Entities: GuestbookEntry
│   ├── capabilities.ir.json ← Operations: CreateEntry, ListEntries
│   ├── boundary.ir.json    ← API surface & auth rules
│   ├── persistence.ir.json ← SQLite tables and schemas
│   └── frontend.ir.json    ← UI screens and form components
└── projection.config.json  ← Target adapter configuration
```

---

## Step 3: Validate the Application IR

Before compiling, validate that all Zod schemas and cross-references are valid:

```bash
od app validate --project ./my-guestbook
```

**Expected Result:**
```text
✓ Validating application IR bundle...
✓ Checking entity cross-references...
✓ Validating component slot bindings...
Result: VALID (0 errors, 0 warnings)
```

*(If there are semantic syntax errors, the command prints exact JSON path diagnostics.)*

---

## Step 4: Generate a Compile Plan

Generate a reviewable compile plan without modifying any files on disk:

```bash
od app plan --project ./my-guestbook --target react-vite
```

**Expected Result:**
The compiler evaluates the target and prints the planned changes:
```text
Target: react-vite
Plan Hash: 9f8a3b2c1d0e...
File Changes:
  + CREATE src/App.tsx
  + CREATE src/components/GuestbookForm.tsx
  + CREATE src/components/GuestbookList.tsx
  + CREATE package.json
  + CREATE vite.config.ts
Conflicts: 0
```

---

## Step 5: Compile the Application

Execute the full compilation pipeline and follow its progress:

```bash
od app compile --project ./my-guestbook --target react-vite --follow
```

**Expected Result:**
The pipeline executes all 9 passes, writes files, updates the manifest, and runs automated build verification:
```text
[1/9] Validating IR bundle... OK
[2/9] Resolving references... OK
[3/9] Normalizing IDs... OK
[4/9] Domain & capability checks... OK
[5/9] Lowering frontend components... OK
[6/9] Target planning... OK
[7/9] Projecting files via reactViteAdapter... OK
[8/9] Writing files to generated/react-vite... OK
[9/9] Verifying production build... OK
Compilation succeeded! (planHash: 9f8a3b2c1d0e)
Output available at: ./my-guestbook/generated/react-vite
```

---

## Step 6: Verify the Generated Application

Inspect the generated directory and run the standalone React application:

```bash
cd ./my-guestbook/generated/react-vite
pnpm install
pnpm build
pnpm preview
```

**Verification:**
The Vite build succeeds with zero errors, producing production-optimized JavaScript and CSS bundles ready to deploy.

---

## Next Steps

- Learn how manual edits are preserved: read [Explanation: Why a 9-Pass Compiler?](file:///home/sprime01/projects/open-design/docs/explanations/nine-pass-compiler.md).
- Compile additional targets: try `od app compile --project ./my-guestbook --target sqlite-better-sqlite3`.
- Inspect the schema definitions: consult the [Application IR Schema Reference](file:///home/sprime01/projects/open-design/docs/reference/ir-schema.md).
