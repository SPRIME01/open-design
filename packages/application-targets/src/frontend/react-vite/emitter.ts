import { ResolvedApplicationIR } from "@open-design/application-ir";
import { FileChange } from "@open-design/application-compiler";

export function emitReactVite(ir: ResolvedApplicationIR): FileChange[] {
  const packageJson = {
    name: ir.bundle.applicationId,
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: {
      dev: "vite",
      build: "tsc && vite build",
      preview: "vite preview"
    },
    dependencies: {
      "react": "^18.3.1",
      "react-dom": "^18.3.1"
    },
    devDependencies: {
      "typescript": "^5.5.0",
      "vite": "^5.4.0",
      "@vitejs/plugin-react": "^5.0.0",
      "@types/react": "^18.3.0",
      "@types/react-dom": "^18.3.0"
    }
  };

  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});`;

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>React Vite App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

  const mainTsx = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`;

  let appTsx = `import React from 'react';

export default function App() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>React/Vite App: ${ir.bundle.name}</h1>
`;

  for (const screen of ir.frontend.screens) {
    appTsx += `      <section id="${screen.id}">\n        <h2>Screen: ${screen.id}</h2>\n`;
    for (const node of ir.frontend.nodes) {
      if (node.level === "atomic") {
        if (node.kind === "button") {
          appTsx += `        <button id="${node.id}">${node.id}</button>\n`;
        } else if (node.kind === "input") {
          appTsx += `        <input id="${node.id}" type="text" placeholder="${node.id}" />\n`;
        }
      }
    }
    appTsx += `      </section>\n`;
  }

  appTsx += `    </div>\n  );\n}`;

  const tsconfigJson = `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}`;

  return [
    {
      path: "package.json",
      content: JSON.stringify(packageJson, null, 2),
      sourceIds: [ir.bundle.applicationId],
    },
    {
      path: "vite.config.ts",
      content: viteConfig,
      sourceIds: [],
    },
    {
      path: "tsconfig.json",
      content: tsconfigJson,
      sourceIds: [],
    },
    {
      path: "index.html",
      content: indexHtml,
      sourceIds: [],
    },
    {
      path: "src/main.tsx",
      content: mainTsx,
      sourceIds: [],
    },
    {
      path: "src/App.tsx",
      content: appTsx,
      sourceIds: ir.frontend.screens.map(s => s.id),
    }
  ];
}

