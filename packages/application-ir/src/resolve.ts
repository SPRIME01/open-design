import { Diagnostic, createErrorDiagnostic } from "./diagnostics.js";
import { ResolvedApplicationIR } from "./types.js";

export function resolveCrossReferences(ir: ResolvedApplicationIR): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const appId = ir.bundle.applicationId;

  // 1. Verify all modules match bundle applicationId
  if (ir.domain.applicationId !== appId) {
    diagnostics.push(
      createErrorDiagnostic("cross_reference_error", `Domain module applicationId mismatch. Expected ${appId}, got ${ir.domain.applicationId}`, "validation", { sourceFile: ir.bundle.modules.domain })
    );
  }
  if (ir.capabilities.applicationId !== appId) {
    diagnostics.push(
      createErrorDiagnostic("cross_reference_error", `Capabilities module applicationId mismatch. Expected ${appId}, got ${ir.capabilities.applicationId}`, "validation", { sourceFile: ir.bundle.modules.capabilities })
    );
  }
  if (ir.boundary.applicationId !== appId) {
    diagnostics.push(
      createErrorDiagnostic("cross_reference_error", `Boundary module applicationId mismatch. Expected ${appId}, got ${ir.boundary.applicationId}`, "validation", { sourceFile: ir.bundle.modules.boundary })
    );
  }
  if (ir.persistence.applicationId !== appId) {
    diagnostics.push(
      createErrorDiagnostic("cross_reference_error", `Persistence module applicationId mismatch. Expected ${appId}, got ${ir.persistence.applicationId}`, "validation", { sourceFile: ir.bundle.modules.persistence })
    );
  }
  if (ir.frontend.applicationId !== appId) {
    diagnostics.push(
      createErrorDiagnostic("cross_reference_error", `Frontend module applicationId mismatch. Expected ${appId}, got ${ir.frontend.applicationId}`, "validation", { sourceFile: ir.bundle.modules.frontend })
    );
  }

  // Build lookup maps
  const domainEntities = new Set(ir.domain.entities.map(e => e.id));
  const capabilityQueries = new Set(ir.capabilities.queries.map(q => q.id));
  const capabilityCommands = new Set(ir.capabilities.commands.map(c => c.id));
  const capabilityAll = new Set([...capabilityQueries, ...capabilityCommands]);
  const boundaryOperations = new Set(ir.boundary.operations.map(o => o.id));
  const persistenceAggregates = new Set(ir.persistence.aggregates.map(a => a.id));
  
  const frontendScreens = new Set(ir.frontend.screens.map(s => s.id));
  const frontendNodes = new Set(ir.frontend.nodes.map(n => n.id));

  // 2. Validate route screen references
  for (const route of ir.frontend.routes) {
    if (!frontendScreens.has(route.screen)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Route '${route.id}' references non-existent screen '${route.screen}'`, "validation", { sourceFile: ir.bundle.modules.frontend, affectedIds: [route.id] })
      );
    }
  }

  // 3. Validate screen rootNode references
  for (const screen of ir.frontend.screens) {
    if (!frontendNodes.has(screen.rootNode)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Screen '${screen.id}' references non-existent rootNode '${screen.rootNode}'`, "validation", { sourceFile: ir.bundle.modules.frontend, affectedIds: [screen.id] })
      );
    }
  }

  // 4. Validate node child and slot references
  for (const node of ir.frontend.nodes) {
    if (node.children) {
      for (const child of node.children) {
        if (!frontendNodes.has(child)) {
          diagnostics.push(
            createErrorDiagnostic("cross_reference_error", `Node '${node.id}' references non-existent child '${child}'`, "validation", { sourceFile: ir.bundle.modules.frontend, affectedIds: [node.id] })
          );
        }
      }
    }
    if (node.slots) {
      for (const [slotName, slotNodes] of Object.entries(node.slots)) {
        for (const child of slotNodes) {
          if (!frontendNodes.has(child)) {
            diagnostics.push(
              createErrorDiagnostic("cross_reference_error", `Node '${node.id}' in slot '${slotName}' references non-existent node '${child}'`, "validation", { sourceFile: ir.bundle.modules.frontend, affectedIds: [node.id] })
            );
          }
        }
      }
    }
    // Validate operation action references
    if (node.actions) {
      for (const action of node.actions) {
        if (action.operation && !boundaryOperations.has(action.operation)) {
          diagnostics.push(
            createErrorDiagnostic("cross_reference_error", `Node '${node.id}' action references non-existent operation '${action.operation}'`, "validation", { sourceFile: ir.bundle.modules.frontend, affectedIds: [node.id] })
          );
        }
      }
    }
  }

  // 5. Validate boundary operations point to capability
  for (const op of ir.boundary.operations) {
    if (!capabilityAll.has(op.capability)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Boundary operation '${op.id}' references non-existent capability '${op.capability}'`, "validation", { sourceFile: ir.bundle.modules.boundary, affectedIds: [op.id] })
      );
    }
  }

  // 6. Validate persistence aggregates rootEntity
  for (const agg of ir.persistence.aggregates) {
    if (!domainEntities.has(agg.rootEntity)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Persistence aggregate '${agg.id}' references non-existent domain rootEntity '${agg.rootEntity}'`, "validation", { sourceFile: ir.bundle.modules.persistence, affectedIds: [agg.id] })
      );
    }
  }

  // 7. Validate persistence repositories aggregate
  for (const repo of ir.persistence.repositories) {
    if (!persistenceAggregates.has(repo.aggregate)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Persistence repository '${repo.id}' references non-existent aggregate '${repo.aggregate}'`, "validation", { sourceFile: ir.bundle.modules.persistence, affectedIds: [repo.id] })
      );
    }
  }

  // 8. Validate persistence indexes/uniqueness/deletion policies entities
  for (const idx of ir.persistence.indexes) {
    if (!domainEntities.has(idx.entity)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Persistence index '${idx.id}' references non-existent domain entity '${idx.entity}'`, "validation", { sourceFile: ir.bundle.modules.persistence, affectedIds: [idx.id] })
      );
    }
  }
  for (const uniq of ir.persistence.uniqueness) {
    if (!domainEntities.has(uniq.entity)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Persistence uniqueness '${uniq.id}' references non-existent domain entity '${uniq.entity}'`, "validation", { sourceFile: ir.bundle.modules.persistence, affectedIds: [uniq.id] })
      );
    }
  }
  for (const dp of ir.persistence.deletionPolicies) {
    if (!domainEntities.has(dp.entity)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Persistence deletion policy references non-existent domain entity '${dp.entity}'`, "validation", { sourceFile: ir.bundle.modules.persistence })
      );
    }
  }

  // 9. Validate persistence concurrency aggregate
  for (const conc of ir.persistence.concurrency) {
    if (!persistenceAggregates.has(conc.aggregate)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Persistence concurrency references non-existent aggregate '${conc.aggregate}'`, "validation", { sourceFile: ir.bundle.modules.persistence })
      );
    }
  }

  // 10. Validate frontend operationBindings references
  for (const opB of ir.frontend.operationBindings) {
    if (!frontendNodes.has(opB.node)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Frontend operation binding references non-existent node '${opB.node}'`, "validation", { sourceFile: ir.bundle.modules.frontend })
      );
    }
    if (!boundaryOperations.has(opB.operation)) {
      diagnostics.push(
        createErrorDiagnostic("cross_reference_error", `Frontend operation binding references non-existent operation '${opB.operation}'`, "validation", { sourceFile: ir.bundle.modules.frontend })
      );
    }
  }

  return diagnostics;
}
