import { ResolvedApplicationIR } from "@open-design/application-ir";
import { FileChange } from "@open-design/application-compiler";

export function emitMockLocal(ir: ResolvedApplicationIR): FileChange[] {
  let content = `// Local mock service generated from Boundary IR
export const mockService = {
`;

  for (const op of ir.boundary.operations) {
    content += `  async "${op.id}"(input: any): Promise<any> {
    console.log("Mock executing ${op.id} with input:", input);
    // Latency simulation
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Simple mock responses
    if ("${op.id}".endsWith(".list")) {
      return { items: [], total: 0 };
    }
    if ("${op.id}".endsWith(".create")) {
      return { id: "mock-id-123", ...input, version: 1 };
    }
    return { success: true };
  },
`;
  }

  content += `};\n`;

  return [
    {
      path: "src/generated/mock-service.ts",
      content,
      sourceIds: ir.boundary.operations.map(o => o.id),
    }
  ];
}
