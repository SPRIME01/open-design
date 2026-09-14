// @vitest-environment jsdom

/**
 * Spec §17.1 rows "Accessibility" and "Responsive" (OPEN_DESIGN_APPLICATION_
 * COMPILER_SPEC.md): required routes compile to zero critical/serious axe
 * violations, and the emitted html-static CSS carries the declared
 * responsive behavior (breakpoints + no horizontal overflow).
 *
 * axe-core runs against a jsdom DOM (the per-file `@vitest-environment jsdom`
 * docblock above provides it), so rules that require a real layout/paint
 * engine are explicitly disabled below with one-line reasons.
 *
 * Deviation (recorded in the N3 iteration report): real-viewport rendering
 * checks (phone/tablet/desktop screenshots, true horizontal-overflow
 * measurement) need Playwright browsers, which are not installed on this
 * machine. The responsive assertions here are therefore static CSS
 * guarantees: breakpoint presence and absence of viewport-exceeding fixed
 * widths.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import axe from "axe-core";
import { compile } from "@open-design/application-compiler";
import { registerAllBuiltInAdapters } from "../src/index.js";

const fixturesRoot = path.join(import.meta.dirname, "../../application-ir/tests/fixtures/valid");
const guestbookRoot = path.join(import.meta.dirname, "../../../examples/guestbook");

interface Fixture {
  name: string;
  dir: string;
}

const auditFixtures: Fixture[] = [
  { name: "marketing-site", dir: path.join(fixturesRoot, "marketing-site") },
  { name: "auth-settings", dir: path.join(fixturesRoot, "auth-settings") },
  { name: "mobile-onboarding", dir: path.join(fixturesRoot, "mobile-onboarding") },
  { name: "guestbook-example", dir: guestbookRoot },
];

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

async function compileHtmlStatic(dir: string): Promise<string> {
  const raw = loadRaw(dir);
  const config = {
    schemaVersion: 1,
    application: "application.ir.json",
    targets: [
      {
        id: "html-static",
        adapter: "html-static",
        mode: "scaffold" as const,
        outputRoot: "generated/html-static",
        frontend: { adapter: "html-static" },
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
    "html-static"
  );
  expect(res.status).toBe("succeeded");
  const html = res.fileSet?.files.find(f => f.path === "index.html")?.content;
  expect(html).toBeDefined();
  return html as string;
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Materializes the generated index.html to disk (audit bytes a consumer would
 * actually serve), loads them into THIS file's jsdom environment, and runs
 * axe against the resulting document.
 */
async function auditFixture(dir: string) {
  const html = await compileHtmlStatic(dir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "od-a11y-"));
  tempDirs.push(tempDir);
  const htmlPath = path.join(tempDir, "index.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  const fromDisk = fs.readFileSync(htmlPath, "utf8");

  document.open();
  document.write(fromDisk);
  document.close();

  return axe.run(document, {
    rules: {
      // jsdom applies no layout/paint; computed contrast resolution is not
      // trustworthy there, so this vision-dependent rule is disabled.
      "color-contrast": { enabled: false },
    },
  });
}

describe("html-static accessibility (spec §17.1)", () => {
  beforeAll(() => {
    registerAllBuiltInAdapters();
  });

  for (const fixture of auditFixtures) {
    it(`emits zero critical/serious axe violations for ${fixture.name}`, async () => {
      const result = await auditFixture(fixture.dir);
      const blocking = result.violations.filter(v =>
        ["critical", "serious"].includes(v.impact ?? "")
      );
      const printed = blocking
        .map(
          v =>
            `${v.id} (${v.impact}): ${v.nodes
              .map(n => n.target.join(" "))
              .join("; ")}`
        )
        .join("\n");
      expect(printed, `axe violations for ${fixture.name}:\n${printed}`).toBe("");
    });
  }
});

describe("html-static responsive CSS (spec §17.1, static scope)", () => {
  beforeAll(() => {
    registerAllBuiltInAdapters();
  });

  for (const fixture of auditFixtures) {
    it(`declares phone/tablet/desktop breakpoints for ${fixture.name}`, async () => {
      const html = await compileHtmlStatic(fixture.dir);
      const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

      const minWidthQueries = style.match(/@media\s*\(min-width:\s*(\d+)px\)/g) ?? [];
      expect(minWidthQueries.length, `breakpoints in ${fixture.name}`).toBeGreaterThanOrEqual(2);

      const breakpoints = minWidthQueries
        .map(q => Number(/(\d+)px/.exec(q)?.[1]))
        .sort((a, b) => a - b);
      // Base layout is the phone; tablet and desktop are additive adjustments.
      expect(breakpoints[0]).toBeGreaterThanOrEqual(768);
      expect(breakpoints[1]).toBeGreaterThanOrEqual(1024);
    });

    it(`keeps horizontal overflow bounded for ${fixture.name}`, async () => {
      const html = await compileHtmlStatic(fixture.dir);
      const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

      // The body clips any stray overflow instead of allowing horizontal
      // scrolling on narrow viewports.
      expect(style).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/);

      // No fixed/min width in px may exceed a small-phone viewport (~390px),
      // so no rule can force content wider than the phone viewport.
      const fixedWidths = [
        ...style.matchAll(/(?:^|[{;])\s*(min-width|width)\s*:\s*(\d+(?:\.\d+)?)px/g),
      ].map(m => Number(m[2]));
      for (const w of fixedWidths) {
        expect(w, `fixed width ${w}px exceeds phone viewport`).toBeLessThanOrEqual(390);
      }
    });
  }
});
