import { ResolvedApplicationIR, FrontendNode } from "@open-design/application-ir";
import { FileChange } from "@open-design/application-compiler";

// Frontend IR responsive declarations (node.responsive: viewport -> layout)
// map onto wrapper classes. The emitted stylesheet is mobile-first: the base
// rules ARE the phone layout, and tablet/desktop are additive min-width
// adjustments, so DOM order (declared ordering) holds at every viewport.
// Iteration order is fixed so emission stays deterministic.
const RESPONSIVE_VIEWPORTS = ["phone", "tablet", "desktop"] as const;
const RESPONSIVE_LAYOUTS: readonly string[] = ["stack", "grid", "centered-column"];

function responsiveClasses(node: FrontendNode): string[] {
  const responsive = node.responsive;
  if (!responsive) return [];
  const classes: string[] = [];
  for (const viewport of RESPONSIVE_VIEWPORTS) {
    const declaration = responsive[viewport];
    if (
      typeof declaration === "string" &&
      RESPONSIVE_LAYOUTS.includes(declaration)
    ) {
      classes.push(`od-rp-${viewport}-${declaration}`);
    }
  }
  return classes;
}

export function emitHtmlStatic(ir: ResolvedApplicationIR): FileChange[] {
  // Simple HTML representation of the routes and screens
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ir.bundle.name}</title>
  <style>
    :root {
      --bg: #ffffff;
      --surface: #f3f4f6;
      --fg: #111827;
      --muted: #6b7280;
      --border: #e5e7eb;
      --accent: #2563eb;
    }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: sans-serif;
      margin: 0;
      padding: 1rem;
      overflow-x: hidden;
    }
    .screen {
      border: 1px solid var(--border);
      background-color: var(--surface);
      padding: 1.5rem;
      border-radius: 8px;
      margin-bottom: 2rem;
    }
    .node {
      padding: 0.5rem;
      margin: 0.5rem 0;
      border: 1px dashed var(--muted);
      max-width: 100%;
    }
    button {
      background-color: var(--accent);
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      cursor: pointer;
    }
    input, textarea {
      border: 1px solid var(--border);
      padding: 0.5rem;
      border-radius: 4px;
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
    }
    /* Phone (base): declared layouts stack in a single column. */
    .od-rp-phone-stack {
      display: flex;
      flex-direction: column;
    }
    /* Tablet: breathing room only; layout stays single-column. */
    @media (min-width: 768px) {
      body {
        padding: 2rem;
      }
    }
    /* Desktop: declared desktop layouts apply; ordering is unchanged. */
    @media (min-width: 1024px) {
      .screen {
        max-width: 60rem;
      }
      .od-rp-desktop-stack {
        display: flex;
        flex-direction: column;
      }
      .od-rp-desktop-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
        gap: 1rem;
        align-items: start;
      }
      .od-rp-desktop-centered-column {
        max-width: 40rem;
        margin-left: auto;
        margin-right: auto;
      }
    }
  </style>
</head>
<body>
  <main>
  <h1>${ir.bundle.name} (Preview)</h1>
`;

  // Render screens
  for (const screen of ir.frontend.screens) {
    html += `  <div class="screen" id="${screen.id}">\n    <h2>Screen: ${screen.id}</h2>\n`;

    // Find root node
    const rootNode = ir.frontend.nodes.find(n => n.id === screen.rootNode);
    if (rootNode) {
      html += renderNode(rootNode, ir.frontend.nodes);
    }

    html += `  </div>\n`;
  }

  html += `
  <script>
    console.log("Interactive HTML prototype initialized.");
  </script>
  </main>
</body>
</html>`;

  return [
    {
      path: "index.html",
      content: html,
      sourceIds: ir.frontend.screens.map(s => s.id),
    }
  ];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nodeLabel(node: FrontendNode): string {
  const label = node.accessibility?.label;
  return escapeHtml(typeof label === "string" && label.length > 0 ? label : node.id);
}

function renderNode(node: FrontendNode, allNodes: FrontendNode[]): string {
  const responsive = responsiveClasses(node).join(" ");
  const classes = responsive.length > 0 ? `node ${responsive}` : "node";
  let content = `    <div class="${classes}" id="${node.id}" data-od-id="${node.id}">\n`;
  content += `      <strong>[${node.level}] ${node.kind} (${node.id})</strong>\n`;

  if (node.slots) {
    for (const [slotName, childIds] of Object.entries(node.slots)) {
      content += `      <div class="slot-${slotName}">\n`;
      for (const childId of childIds as string[]) {
        const child = allNodes.find(n => n.id === childId);
        if (child) {
          content += renderNode(child, allNodes);
        }
      }
      content += `      </div>\n`;
    }
  }

  const label = nodeLabel(node);
  const required = node.accessibility?.required === true ? " required" : "";
  if (node.kind === "button") {
    content += `      <button>${label}</button>\n`;
  } else if (node.kind === "input") {
    content += `      <label>${label} <input type="text"${required} /></label>\n`;
  } else if (node.kind === "textarea") {
    content += `      <label>${label} <textarea${required}></textarea></label>\n`;
  }

  content += `    </div>\n`;
  return content;
}
