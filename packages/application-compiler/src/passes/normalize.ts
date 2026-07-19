import { ResolvedApplicationIR, Diagnostic, normalizeId } from "@open-design/application-ir";

export const normalizePass = {
  name: "normalize",
  inputVersion: "1.0.0",
  outputVersion: "1.0.0",
  run(ir: ResolvedApplicationIR): { ir: ResolvedApplicationIR; diagnostics: Diagnostic[] } {
    // Return a new IR with normalized IDs across all modules
    const domain = {
      ...ir.domain,
      entities: ir.domain.entities.map(e => ({
        ...e,
        id: normalizeId(e.id, "entity"),
      }))
    };

    const frontend = {
      ...ir.frontend,
      nodes: ir.frontend.nodes.map(n => ({
        ...n,
        id: normalizeId(n.id, n.level),
      }))
    };

    return {
      ir: { ...ir, domain, frontend },
      diagnostics: [],
    };
  }
};
