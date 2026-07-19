import { adapterRegistry } from "@open-design/application-compiler";
import { HtmlStaticAdapter } from "./frontend/html-static/adapter.js";
import { ReactViteAdapter } from "./frontend/react-vite/adapter.js";
import { NextjsAppAdapter } from "./frontend/nextjs-app/adapter.js";
import { SvelteKitAdapter } from "./frontend/sveltekit/adapter.js";
import { MockLocalAdapter } from "./transport/mock-local/adapter.js";
import { NextServerActionsAdapter } from "./transport/next-server-actions/adapter.js";
import { SqliteBetterSqlite3Adapter } from "./persistence/sqlite-better-sqlite3/adapter.js";

export * from "./frontend/index.js";
export * from "./transport/index.js";
export * from "./persistence/index.js";

export function registerAllBuiltInAdapters() {
  try {
    adapterRegistry.register(new HtmlStaticAdapter());
    adapterRegistry.register(new ReactViteAdapter());
    adapterRegistry.register(new NextjsAppAdapter());
    adapterRegistry.register(new SvelteKitAdapter());
    adapterRegistry.register(new MockLocalAdapter());
    adapterRegistry.register(new NextServerActionsAdapter());
    adapterRegistry.register(new SqliteBetterSqlite3Adapter());
  } catch (e) {
    // Ignore duplicate registration errors in tests
  }
}
