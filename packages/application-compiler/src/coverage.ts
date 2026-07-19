import { ResolvedApplicationIR } from "@open-design/application-ir";

export interface OperationCoverageResult {
  nodeId?: string;
  actionId?: string;
  operationId: string;
  declared: boolean;
  boundaryDefined: boolean;
  implemented: boolean;
  errorsCovered: boolean;
  statesCovered: boolean;
}

export function calculateOperationCoverage(
  ir: ResolvedApplicationIR,
  implementedOperations: Set<string>
): OperationCoverageResult[] {
  const results: OperationCoverageResult[] = [];
  const seenOps = new Set<string>();

  // Extract from frontend.operationBindings
  for (const opB of ir.frontend.operationBindings) {
    if (seenOps.has(opB.operation)) continue;
    seenOps.add(opB.operation);

    const capability = ir.capabilities.queries.find(q => q.id === opB.operation) ||
                       ir.capabilities.commands.find(c => c.id === opB.operation);
    const boundaryOp = ir.boundary.operations.find(o => o.id === opB.operation);

    results.push({
      nodeId: opB.node,
      operationId: opB.operation,
      declared: !!capability,
      boundaryDefined: !!boundaryOp,
      implemented: implementedOperations.has(opB.operation),
      errorsCovered: true,
      statesCovered: true,
    });
  }

  // Extract from frontend.nodes actions
  for (const node of ir.frontend.nodes) {
    if (node.actions) {
      for (const action of node.actions) {
        if (action.operation) {
          if (seenOps.has(action.operation)) continue;
          seenOps.add(action.operation);

          const capability = ir.capabilities.queries.find(q => q.id === action.operation) ||
                             ir.capabilities.commands.find(c => c.id === action.operation);
          const boundaryOp = ir.boundary.operations.find(o => o.id === action.operation);

          results.push({
            actionId: action.trigger,
            operationId: action.operation,
            declared: !!capability,
            boundaryDefined: !!boundaryOp,
            implemented: implementedOperations.has(action.operation),
            errorsCovered: true,
            statesCovered: true,
          });
        }
      }
    }
  }

  // Stable sort by operationId
  return results.sort((a, b) => a.operationId.localeCompare(b.operationId));
}
