import * as fs from "node:fs";
import * as path from "node:path";
import { compile, CompileResult } from "@open-design/application-compiler";
import { registerAllBuiltInAdapters } from "@open-design/application-targets";
import { runPersistence } from "./run-persistence.js";
import { ProjectWriter } from "./project-writer.js";
import { runVerificationStep } from "./verification-runner.js";
import { CompilerRunStatus } from "@open-design/contracts";

registerAllBuiltInAdapters();

const runListeners = new Map<string, ((event: any) => void)[]>();

export const compilerService = {
  getListeners(runId: string) {
    if (!runListeners.has(runId)) {
      runListeners.set(runId, []);
    }
    return runListeners.get(runId)!;
  },

  emitEvent(runId: string, type: string, data: any) {
    const listeners = this.getListeners(runId);
    for (const listener of listeners) {
      listener({ type, data });
    }
  },

  async startRun(
    projectRoot: string,
    targetId: string,
    runId = `run-${Date.now()}`
  ): Promise<CompilerRunStatus> {
    const startedAt = new Date().toISOString();
    const status: CompilerRunStatus = {
      runId,
      status: "queued",
      phase: "validation",
      progress: 0,
      diagnostics: [],
      startedAt,
    };
    runPersistence.save(status);

    // Run compile asynchronously
    this.executeRun(projectRoot, targetId, runId).catch(console.error);

    return status;
  },

  async executeRun(projectRoot: string, targetId: string, runId: string) {
    const status = runPersistence.get(runId);
    if (!status) return;

    const emitPhase = (phase: CompilerRunStatus["phase"], statusStr: CompilerRunStatus["status"], progress: number) => {
      status.phase = phase;
      status.status = statusStr;
      status.progress = progress;
      runPersistence.save(status);
      this.emitEvent(runId, "progress", status);
    };

    try {
      emitPhase("validation", "validating", 10);

      // Load IR files from projectRoot
      // By convention, they reside in projectRoot/application.ir.json and projectRoot/ir/
      const appIrPath = path.join(projectRoot, "application.ir.json");
      if (!fs.existsSync(appIrPath)) {
        throw new Error(`application.ir.json not found at ${appIrPath}`);
      }

      const bundleRaw = JSON.parse(fs.readFileSync(appIrPath, "utf8"));
      const getModuleRaw = (relPath: string) => {
        const fullPath = path.resolve(projectRoot, relPath);
        if (!fs.existsSync(fullPath)) return {};
        return JSON.parse(fs.readFileSync(fullPath, "utf8"));
      };

      const domainRaw = getModuleRaw(bundleRaw.modules?.domain || "ir/domain.ir.json");
      const capabilitiesRaw = getModuleRaw(bundleRaw.modules?.capabilities || "ir/capabilities.ir.json");
      const boundaryRaw = getModuleRaw(bundleRaw.modules?.boundary || "ir/boundary.ir.json");
      const persistenceRaw = getModuleRaw(bundleRaw.modules?.persistence || "ir/persistence.ir.json");
      const frontendRaw = getModuleRaw(bundleRaw.modules?.frontend || "ir/frontend.ir.json");

      // Load projection config
      const projConfigPath = path.join(projectRoot, "projection.config.json");
      const config = fs.existsSync(projConfigPath)
        ? JSON.parse(fs.readFileSync(projConfigPath, "utf8"))
        : {
            schemaVersion: 1,
            application: "application.ir.json",
            targets: [
              {
                id: targetId,
                adapter: "html-static",
                mode: "scaffold",
                outputRoot: "generated/html-static",
                frontend: { adapter: "html-static" }
              }
            ]
          };

      // Load prior manifest if exists
      const manifestPath = path.join(projectRoot, "generated", targetId, "manifest.json");
      let priorManifest = null;
      if (fs.existsSync(manifestPath)) {
        try {
          priorManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (_) {}
      }

      emitPhase("lowering", "lowering", 30);

      const targetConfig = config.targets.find((t: any) => t.id === targetId);
      const outputRoot = targetConfig
        ? path.resolve(projectRoot, targetConfig.outputRoot)
        : path.resolve(projectRoot, "generated", targetId);

      const currentFilesFetcher = (rel: string) => {
        const full = path.resolve(outputRoot, rel);
        const exists = fs.existsSync(full);
        return {
          exists,
          content: exists ? fs.readFileSync(full, "utf8") : null,
        };
      };

      const compileRes = await compile(
        bundleRaw,
        domainRaw,
        capabilitiesRaw,
        boundaryRaw,
        persistenceRaw,
        frontendRaw,
        config,
        targetId,
        {
          runId,
          priorManifest,
          currentFilesFetcher,
        }
      );

      if (compileRes.status === "failed-validation" || compileRes.status === "failed-lowering" || compileRes.status === "failed-planning") {
        status.status = "failed";
        status.diagnostics = compileRes.diagnostics.map((d: any) => ({
          ...d,
          phase: d.phase as any,
          severity: d.severity as any,
        }));
        status.completedAt = new Date().toISOString();
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }

      // If planning succeeded, but blocked or conflicted, we report it
      if (compileRes.status === "blocked" || compileRes.status === "conflicted") {
        status.status = "failed";
        if (compileRes.plan?.planHash) {
          status.planHash = compileRes.plan.planHash;
        }
        status.diagnostics = [
          {
            code: compileRes.status === "blocked" ? "unresolved_references" : "file_conflicts",
            message: `Compile blocked: ${compileRes.status === "blocked" ? "Unresolved references in adapters." : "Unresolved conflicts in manual files."}`,
            severity: "error",
            phase: "planning",
          }
        ];
        status.completedAt = new Date().toISOString();
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }

      // Phase: Writing files
      emitPhase("write", "writing", 60);
      const writer = new ProjectWriter(outputRoot);
      writer.stageAndWrite(compileRes.fileSet!.files);

      // Save manifest and plan to outputRoot
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "manifest.json"), JSON.stringify(compileRes.manifest, null, 2), "utf8");
      fs.writeFileSync(path.join(outputRoot, "plan.json"), JSON.stringify(compileRes.plan, null, 2), "utf8");

      // Phase: Verification
      emitPhase("verification", "verifying", 80);
      let verifySuccess = true;
      const verifyOutputLogs: string[] = [];

      if (compileRes.plan?.verificationPlanned) {
        for (const step of compileRes.plan.verificationPlanned) {
          const stepRes = await runVerificationStep(step.name, step.command, outputRoot);
          verifyOutputLogs.push(stepRes.output);
          if (!stepRes.success) {
            verifySuccess = false;
          }
        }
      }

      if (!verifySuccess) {
        status.status = "failed";
        status.diagnostics = [
          {
            code: "verification_failed",
            message: `One or more verification steps failed. Output logs:\n${verifyOutputLogs.join("\n")}`,
            severity: "error",
            phase: "verification",
          }
        ];
        status.completedAt = new Date().toISOString();
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }

      // Succeeded!
      status.status = "succeeded";
      status.phase = "idle";
      status.progress = 100;
      if (compileRes.plan?.planHash) {
        status.planHash = compileRes.plan.planHash;
      }
      status.completedAt = new Date().toISOString();
      runPersistence.save(status);
      this.emitEvent(runId, "success", status);

    } catch (err: any) {
      status.status = "failed";
      status.diagnostics = [
        {
          code: "unexpected_error",
          message: `Unexpected compilation error: ${err.message}`,
          severity: "error",
          phase: (status.phase === "idle" ? "validation" : status.phase) as any,
        }
      ];
      status.completedAt = new Date().toISOString();
      runPersistence.save(status);
      this.emitEvent(runId, "failure", status);
    }
  }
};
