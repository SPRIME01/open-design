import { ResolvedApplicationIR } from "./types.js";

export function migrateResolvedIR(ir: ResolvedApplicationIR, targetVersion: string): ResolvedApplicationIR {
  // Pure transform logic. In v0.1.0 we support version 1.0.0.
  // If the incoming version starts with a different major, we reject it.
  const checkVersion = (ver: string, moduleName: string) => {
    const major = ver.split(".")[0];
    const targetMajor = targetVersion.split(".")[0];
    if (major !== targetMajor) {
      throw new Error(`Unsupported major version migration for module '${moduleName}': from ${ver} to ${targetVersion}`);
    }
  };

  checkVersion(ir.bundle.schemaVersion, "bundle");
  checkVersion(ir.domain.schemaVersion, "domain");
  checkVersion(ir.capabilities.schemaVersion, "capabilities");
  checkVersion(ir.boundary.schemaVersion, "boundary");
  checkVersion(ir.persistence.schemaVersion, "persistence");
  checkVersion(ir.frontend.schemaVersion, "frontend");

  // Since they are compatible, we return them with updated versions
  return {
    bundle: { ...ir.bundle, schemaVersion: targetVersion },
    domain: { ...ir.domain, schemaVersion: targetVersion },
    capabilities: { ...ir.capabilities, schemaVersion: targetVersion },
    boundary: { ...ir.boundary, schemaVersion: targetVersion },
    persistence: { ...ir.persistence, schemaVersion: targetVersion },
    frontend: { ...ir.frontend, schemaVersion: targetVersion },
  };
}
