import { ApplicationTargetAdapter } from "./adapter-contract.js";

class AdapterRegistry {
  private adapters = new Map<string, ApplicationTargetAdapter>();

  register(adapter: ApplicationTargetAdapter) {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter with ID '${adapter.id}' is already registered.`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ApplicationTargetAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ApplicationTargetAdapter[] {
    return Array.from(this.adapters.values());
  }

  clear() {
    this.adapters.clear();
  }
}

export const adapterRegistry = new AdapterRegistry();
