import { exec } from "node:child_process";
import { logCompilerEvent } from "./run-logger.js";

export interface VerificationResult {
  success: boolean;
  output: string;
}

/** Run-scoped context a verification step's structured log lines carry (§12.3). */
export interface VerificationStepContext {
  runId: string;
  projectId: string;
  targetId: string;
}

export function runVerificationStep(
  name: string,
  command: { executable: string; argv: string[] },
  cwd: string,
  ctx?: VerificationStepContext,
  timeoutMs = 30000
): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const cmdLine = `${command.executable} ${command.argv.join(" ")}`;
    const startedAt = Date.now();
    if (ctx) {
      logCompilerEvent({
        event: "verification_step_started",
        compiler_run_id: ctx.runId,
        project_id: ctx.projectId,
        target_id: ctx.targetId,
        phase: "verification",
        command_step_id: name,
        command: cmdLine,
      });
    } else {
      console.log(`Running verification step '${name}': ${cmdLine} in ${cwd}`);
    }

    const proc = exec(cmdLine, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      const output = stdout + stderr;
      const durationMs = Date.now() - startedAt;
      if (ctx) {
        logCompilerEvent({
          event: "verification_step_completed",
          compiler_run_id: ctx.runId,
          project_id: ctx.projectId,
          target_id: ctx.targetId,
          phase: "verification",
          command_step_id: name,
          success: !error,
          duration_ms: durationMs,
        });
      }
      if (error) {
        resolve({
          success: false,
          output: `Verification step '${name}' failed.\nError: ${error.message}\nOutput:\n${output}`,
        });
      } else {
        resolve({
          success: true,
          output,
        });
      }
    });
  });
}
