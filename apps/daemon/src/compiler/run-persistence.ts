import { CompilerRunStatus } from "@open-design/contracts";

const compilerRuns = new Map<string, CompilerRunStatus>();

export const runPersistence = {
  save(run: CompilerRunStatus) {
    compilerRuns.set(run.runId, run);
  },

  get(runId: string): CompilerRunStatus | undefined {
    return compilerRuns.get(runId);
  },

  list(): CompilerRunStatus[] {
    return Array.from(compilerRuns.values());
  }
};
