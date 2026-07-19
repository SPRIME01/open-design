import { ResolvedApplicationIR } from "@open-design/application-ir";
import { FileChange } from "@open-design/application-compiler";

export function emitNextServerActions(ir: ResolvedApplicationIR): FileChange[] {
  let content = `"use server";
// Next.js Server Actions generated from Boundary IR

import { mockService } from "./mock-service.js";

`;

  for (const op of ir.boundary.operations) {
    const safeName = op.id.replace(/[.-]/g, "_");
    content += `export async function action_${safeName}(input: any): Promise<any> {
  console.log("Server action executing ${op.id} with input:", input);
  // Boundary validation
  if (input && typeof input === 'object' && 'name' in input && !input.name) {
    throw new Error("VALIDATION_FAILED: name is required");
  }
  
  // Delegate to mockService or DB implementation
  return mockService["${op.id}"](input);
}
`;
  }

  return [
    {
      path: "src/generated/server-actions.ts",
      content,
      sourceIds: ir.boundary.operations.map(o => o.id),
    }
  ];
}
