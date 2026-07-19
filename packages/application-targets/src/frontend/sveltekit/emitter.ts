import { ResolvedApplicationIR } from "@open-design/application-ir";
import { FileChange } from "@open-design/application-compiler";

export function emitSvelteKit(ir: ResolvedApplicationIR): FileChange[] {
  const packageJson = {
    name: ir.bundle.applicationId,
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      preview: "vite preview",
      check: "svelte-check --tsconfig ./tsconfig.json"
    },
    devDependencies: {
      "@sveltejs/adapter-auto": "^3.0.0",
      "@sveltejs/kit": "^2.0.0",
      "@sveltejs/vite-plugin-svelte": "^3.0.0",
      "svelte": "^4.0.0",
      "svelte-check": "^3.6.0",
      "typescript": "^5.0.0",
      "vite": "^5.0.0"
    }
  };

  const svelteConfig = `import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter()
  }
};
export default config;`;

  const viteConfig = `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()]
});`;

  const appHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body>
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>`;

  const layout = `<slot />`;

  let page = `<script lang="ts">
  // SvelteKit Page: ${ir.bundle.name}
</script>

<main style="padding: 2rem; font-family: sans-serif;">
  <h1>SvelteKit: ${ir.bundle.name}</h1>
`;

  for (const screen of ir.frontend.screens) {
    page += `  <section id="${screen.id}">\n    <h2>Screen: ${screen.id}</h2>\n`;
    for (const node of ir.frontend.nodes) {
      if (node.level === "atomic") {
        if (node.kind === "button") {
          page += `    <button id="${node.id}">${node.id}</button>\n`;
        } else if (node.kind === "input") {
          page += `    <input id="${node.id}" type="text" placeholder="${node.id}" />\n`;
        }
      }
    }
    page += `  </section>\n`;
  }

  page += `</main>`;

  const tsconfigJson = `{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022",
    "svelte": {
      "compilerOptions": {
        "css": "inject"
      }
    }
  }
}`;

  return [
    {
      path: "package.json",
      content: JSON.stringify(packageJson, null, 2),
      sourceIds: [ir.bundle.applicationId],
    },
    {
      path: "svelte.config.js",
      content: svelteConfig,
      sourceIds: [],
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
      path: "src/app.html",
      content: appHtml,
      sourceIds: [],
    },
    {
      path: "src/routes/+layout.svelte",
      content: layout,
      sourceIds: [],
    },
    {
      path: "src/routes/+page.svelte",
      content: page,
      sourceIds: ir.frontend.screens.map(s => s.id),
    }
  ];
}

