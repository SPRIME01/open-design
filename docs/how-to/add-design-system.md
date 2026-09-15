# How-To: Add a Brand Design System

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Subsystem Guide:** [`docs/subsystems/content-registries.md`](file:///home/sprime01/projects/open-design/docs/subsystems/content-registries.md)

This procedural guide explains how to author and validate a new brand design system in Open Design.

---

## Goal

Create a new aesthetic brand package under `design-systems/<brand_id>/` that passes all automated token verification and fixture quality gates.

---

## Prerequisites

- Repository cloned and dependencies installed (`pnpm install`).
- Clear visual identity specification for the target brand (typography scales, color palettes, border radiuses, button states).

---

## Step 1: Create the Design System Directory

Create a new directory named with a lower-case kebab-case identifier:

```bash
mkdir -p design-systems/acme-corp
```

---

## Step 2: Author `DESIGN.md`

Create `design-systems/acme-corp/DESIGN.md` describing the visual personality and usage rules:

```markdown
# Acme Corp Design System

## Personality & Aesthetic
Clean, high-contrast, modern enterprise aesthetic with crisp typography and subtle micro-interactions.

## Typography
- Font Family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
- Scales: h1 (32px / 700), h2 (24px / 600), h3 (18px / 600), body (14px / 400), body-sm (12px / 400)

## Spacing & Layout
- 4px grid system: 4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px
- Border Radius: Default 6px, Cards 8px, Modals 12px

## Component Rules
- Buttons: Solid primary with subtle box-shadow; ghost secondary with 1px border.
- Cards: White background on light mode, subtle 1px border (#e5e7eb), no heavy drop shadows.
```

---

## Step 3: Author `tokens.css`

Create `design-systems/acme-corp/tokens.css`. You **must** define all 26 required A1 tokens and all 26 required A2 tokens:

```css
:root {
  /* 26 Required A1 Tokens (Surfaces, Borders, Base Text) */
  --bg-app: #f9fafb;
  --bg-surface: #ffffff;
  --bg-surface-elevated: #ffffff;
  --bg-muted: #f3f4f6;
  --border-subtle: #e5e7eb;
  --border-default: #d1d5db;
  --border-strong: #9ca3af;
  --text-primary: #111827;
  --text-secondary: #4b5563;
  --text-muted: #6b7280;
  --text-inverse: #ffffff;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-full: 9999px;
  --font-sans: Inter, sans-serif;
  --font-mono: monospace;
  /* ... complete required token set ... */

  /* 26 Required A2 Tokens (Brand Accents & Feedback) */
  --accent-primary: #2563eb;
  --accent-primary-hover: #1d4ed8;
  --accent-primary-active: #1e40af;
  --accent-secondary: #475569;
  --feedback-success: #16a34a;
  --feedback-warning: #ca8a04;
  --feedback-error: #dc2626;
  /* ... complete required token set ... */
}
```

---

## Step 4: Author `components.html`

Create `design-systems/acme-corp/components.html`. 

**Critical Rule:** The `:root` declaration inside `components.html` must match `tokens.css` byte-for-byte.

The HTML body must include interactive component examples utilizing the tokens:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Acme Corp Fixtures</title>
  <style>
    /* Injected tokens matching tokens.css */
    :root { ... }
    
    /* Component styles */
    .btn { ... }
    .btn-primary { ... }
    .field { ... }
    .card { ... }
  </style>
</head>
<body>
  <div class="container">
    <h1>Acme Corp Fixtures</h1>
    <div class="stack-4">
      <button class="btn btn-primary">Primary Action</button>
      <button class="btn btn-secondary">Secondary Action</button>
      <div class="field">
        <label for="email">Email Address</label>
        <input id="email" type="email" placeholder="name@acme.com" />
      </div>
      <div class="card">
        <h3>Card Title</h3>
        <p class="body-muted">Card body description text.</p>
      </div>
    </div>
  </div>
</body>
</html>
```

---

## Step 5: Run Automated Verification

Run repository guard checks to verify token completeness and fixture parity:

```bash
pnpm guard
```

**What is checked:**
- `checkDesignSystemA1RequiredTokens`: Verifies all 26 A1 tokens exist.
- `checkDesignSystemA2RequiredTokens`: Verifies all 26 A2 tokens exist.
- `checkDesignSystemTokenFixtureSync`: Verifies `:root` in `components.html` matches `tokens.css` byte-for-byte.
- `checkDesignSystemManifests`: Verifies directory structure and manifest integrity.

---

## Troubleshooting

- **Token parity failure**: Copy the exact `:root` block from `tokens.css` into the `<style>` tag of `components.html`. Whitespace, comments, and values must align.
- **Missing A1/A2 token**: Check the guard report output for the exact name of the missing token variable.
