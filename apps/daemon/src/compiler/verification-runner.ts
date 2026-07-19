import { exec } from "node:child_process";

export interface VerificationResult {
  success: boolean;
  output: string;
}

export function runVerificationStep(
  name: string,
  command: { executable: string; argv: string[] },
  cwd: string,
  timeoutMs = 30000
): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const cmdLine = `${command.executable} ${command.argv.join(" ")}`;
    console.log(`Running verification step '${name}': ${cmdLine} in ${cwd}`);

    const proc = exec(cmdLine, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      const output = stdout + stderr;
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
