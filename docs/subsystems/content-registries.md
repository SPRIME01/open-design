# Subsystem Guide: Content Knowledge Registries

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Source Map:** [`docs/source-map.md`](file:///home/sprime01/projects/open-design/docs/source-map.md) · **How-To Guide:** [`docs/how-to/add-design-system.md`](file:///home/sprime01/projects/open-design/docs/how-to/add-design-system.md)

This document specifies the architecture, file formats, precedence scanning rules, and quality verification standards for Open Design's content knowledge layer.

---

## 1. Purpose

Open Design produces studio-quality interfaces because it grounds AI generation in **curated, real-world design systems and craft heuristics** rather than generic LLM defaults. The content layer is entirely file-based, open, and user-extensible.

---

## 2. Registry Surfaces

The content layer is partitioned into four distinct listing surfaces:

| Surface | Bundled Location | API Endpoint | Primary Purpose |
|---|---|---|---|
| **Brand Design Systems** | [`design-systems/`](file:///home/sprime01/projects/open-design/design-systems/) | `GET /api/design-systems` | 150+ brand aesthetic packages (Linear, Stripe, Apple, Airbnb, etc.) with tokens, fonts, and fixtures. |
| **Functional Skills** | [`skills/`](file:///home/sprime01/projects/open-design/skills/) | `GET /api/skills` | 160+ specialized capabilities that an agent invokes mid-task (charts, decks, video, figma, etc.). |
| **Design Templates** | [`design-templates/`](file:///home/sprime01/projects/open-design/design-templates/) | `GET /api/design-templates` | 110+ renderable starting points for creation workflows (dashboards, decks, mobile apps). |
| **Universal Craft Rules** | [`craft/`](file:///home/sprime01/projects/open-design/craft/) | Composed into prompts | 11 universal heuristics (accessibility baseline, animation discipline, anti-ai-slop, state coverage). |

---

## 3. Brand Design System Architecture

Each directory in `design-systems/<brand>/` contains three synchronized assets:

```text
design-systems/stripe/
├── DESIGN.md           ← Aesthetic principles, typography hierarchies, layout rules
├── tokens.css          ← CSS Custom Properties (:root declarations for colors, spacing, radii)
└── components.html     ← Living HTML component fixture (buttons, inputs, cards, typography)
```

### Invariant: Token-Fixture Synchronization
To ensure that generated code strictly adheres to real brand guidelines, [`scripts/guard.ts`](file:///home/sprime01/projects/open-design/scripts/guard.ts) enforces that:
- Every brand declares all 26 required **A1 tokens** (surface backgrounds, borders, text contrast).
- Every brand declares all 26 required **A2 tokens** (brand accents, hover states, muted fills).
- The `:root` variables in `components.html` match `tokens.css` byte-for-byte.
- Component fixtures define realistic HTML examples for buttons, fields, cards, and typography.

---

## 4. Functional Skills Protocol

Functional skills are located in `skills/<skill_name>/` and defined by a mandatory `SKILL.md` file with YAML frontmatter:

```markdown
---
name: d3-visualization
description: Generates interactive SVG charts and data visualizations using D3.js.
od:
  craft:
    requires:
      - accessibility-baseline
      - state-coverage
---

# Instructions for D3 Visualization
...
```

### Skill Protocol Invariants:
1. **Tool Invocations**: Skills specify tools that the agent can call during its turn.
2. **Craft Opt-In**: The `od.craft.requires` metadata declares which universal craft rules must be appended to the prompt when this skill is active.
3. **Precedence Scanning**: The daemon scans the user-writable registry directory (`<RUNTIME_DATA_DIR>/skills/`) first and the bundled root second. A user skill with the same ID cleanly shadows the bundled skill.

---

## 5. Universal Craft Rules (`craft/`)

Craft rules are brand-agnostic engineering standards that prevent common AI failure modes:

| Rule File | Core Discipline |
|---|---|
| [`craft/anti-ai-slop.md`](file:///home/sprime01/projects/open-design/craft/anti-ai-slop.md) | Prohibits generic AI visual cliches (purplish gradients, uniform card grids, unstyled inputs). |
| [`craft/accessibility-baseline.md`](file:///home/sprime01/projects/open-design/craft/accessibility-baseline.md) | Enforces WCAG 2.1 AA contrast, visible focus rings, label associations, and keyboard navigability. |
| [`craft/animation-discipline.md`](file:///home/sprime01/projects/open-design/craft/animation-discipline.md) | Mandates `cubic-bezier(0.23, 1, 0.32, 1)`, asymmetric enter/exit timings, and forbids `scale(0)`. |
| [`craft/state-coverage.md`](file:///home/sprime01/projects/open-design/craft/state-coverage.md) | Requires explicit UI handling for empty states, loading skeletons, error banners, and overflow text. |
| [`craft/form-validation.md`](file:///home/sprime01/projects/open-design/craft/form-validation.md) | Governs inline error states, field constraints, and submit button disability behavior. |

---

## 6. Verification & Quality Gates

The content layer is continuously audited by repository guard scripts:
- `pnpm lint:craft`: Scans all `SKILL.md` files to verify that referenced craft rules exist in `craft/`.
- `pnpm guard`: Checks 150+ design systems for token parity, fixture validity, and color expression constraints.

---

## 7. Source Trail

- [`design-systems/`](file:///home/sprime01/projects/open-design/design-systems/) — 150+ brand design systems.
- [`skills/`](file:///home/sprime01/projects/open-design/skills/) — Functional skill definitions.
- [`design-templates/`](file:///home/sprime01/projects/open-design/design-templates/) — Renderable starter templates.
- [`craft/`](file:///home/sprime01/projects/open-design/craft/) — Universal craft rule documents.
- [`apps/daemon/src/skills.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/skills.ts) — Daemon skill loader and precedence scanner.
- [`scripts/lint-craft-references.ts`](file:///home/sprime01/projects/open-design/scripts/lint-craft-references.ts) — Craft reference linter.
