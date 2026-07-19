import { ResolvedApplicationIR } from "@open-design/application-ir";
import { FileChange } from "@open-design/application-compiler";

export function emitNextjsApp(ir: ResolvedApplicationIR): FileChange[] {
  const packageJson = {
    name: ir.bundle.applicationId,
    private: true,
    version: "0.1.0",
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start"
    },
    dependencies: {
      "next": "^14.2.0",
      "react": "^18.3.1",
      "react-dom": "^18.3.1"
    },
    devDependencies: {
      "typescript": "^5.5.0",
      "@types/react": "^18.3.0",
      "@types/react-dom": "^18.3.0"
    }
  };

  const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;`;

  const layout = `import React from 'react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}`;

  let page = `import React from 'react';

export default function Page() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Next.js App: ${ir.bundle.name}</h1>
`;

  for (const screen of ir.frontend.screens) {
    page += `      <section id="${screen.id}">\n        <h2>Screen: ${screen.id}</h2>\n`;
    for (const node of ir.frontend.nodes) {
      if (node.level === "atomic") {
        if (node.kind === "button") {
          page += `        <button id="${node.id}">${node.id}</button>\n`;
        } else if (node.kind === "input") {
          page += `        <input id="${node.id}" type="text" placeholder="${node.id}" />\n`;
        }
      }
    }
    page += `      </section>\n`;
  }

  page += `    </div>\n  );\n}`;

  return [
    {
      path: "package.json",
      content: JSON.stringify(packageJson, null, 2),
      sourceIds: [ir.bundle.applicationId],
    },
    {
      path: "next.config.mjs",
      content: nextConfig,
      sourceIds: [],
    },
    {
      path: "src/app/layout.tsx",
      content: layout,
      sourceIds: [],
    },
    {
      path: "src/app/page.tsx",
      content: page,
      sourceIds: ir.frontend.screens.map(s => s.id),
    }
  ];
}
