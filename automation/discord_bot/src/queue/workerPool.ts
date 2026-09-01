import { config } from "../config.js";
import path from "node:path";
import { commitWorkerChanges, publishCanonicalManagementState, publishWorkerBranch } from "../runners/gitPublisher.js";
import { assertArticleImagePaths } from "../runners/imagePathChecker.js";
import { assertMocIntegrity } from "../runners/mocIntegrityChecker.js";
import { hasDurableArticleChanges } from "../runners/publishGateChecker.js";
import { runCodexForJob } from "../runners/codexRunner.js";
import { createWorktree, removeWorktree } from "../runners/workspaceManager.js";
import { canStartWorker } from "../services/resourceGuard.js";
import { writeJobLog } from "../services/logWriter.js";
import type { Job } from "../types.js";
import type { JobStore } from "./jobStore.js";
import type { Notifier } from "../services/notifier.js";
import { WorkerSupervisor } from "../../../ebs/core/src/services/workerSupervisor.js";
import { FilesystemArticleRepository } from "../../../ebs/core/src/infrastructure/filesystemArticleRepository.js";
import { ReconciliationService } from "../../../ebs/core/src/services/reconciliationService.js";
import { runGit } from "../utils/shell.js";
import { CandidateRegistry } from "../../../ebs/core/src/services/candidateRegistry.js";
import { IndexService } from "../../../ebs/core/src/services/indexService.js";
import { BuildService } from "../../../ebs/core/src/services/buildService.js";

export class WorkerPool {
  private timer: NodeJS.Timeout | undefined;
  private readonly supervisor: WorkerSupervisor<Job>;

  constructor(
    private readonly store: JobStore,
    private readonly notifier: Notifier,
  ) {
    this.supervisor = new WorkerSupervisor<Job>({
      repository: store,
      resourceGuard: { canStart: canStartWorker },
      maxWorkers: config.workers.maxWorkers,
      runJob: (job, _signal) => this.runJob(job),
      onGuardBlocked: (reason) => writeJobLog("resource-guard", `${new Date().toISOString()} ${reason}`).then(() => undefined),
    });
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.supervisor.tick();
    }, 5000);
    void this.supervisor.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    await this.supervisor.tick();
  }

  listActiveWorkers() {
    return this.supervisor.listActiveWorkers();
  }

  cancelActiveJob(jobId: string): boolean {
    return this.supervisor.cancelActiveJob(jobId);
  }

  async cleanupFailedWorktrees(olderThanDays: number, dryRun: boolean): Promise<string[]> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const jobs = await this.store.all();
    const targets = jobs.filter((job) => {
      if (!["failed", "failed_review_required", "cancelled"].includes(job.status)) return false;
      if (!job.worktreePath || !job.branchName) return false;
      const finishedAt = job.finishedAt ?? job.updatedAt;
      return new Date(finishedAt).getTime() <= cutoff;
    });
    const cleaned: string[] = [];
    for (const job of targets) {
      cleaned.push(`${job.id}: ${job.worktreePath}`);
      if (!dryRun) {
        await removeWorktree(job.worktreePath!, job.branchName!).catch((error) =>
          writeJobLog(job.id, `cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        await this.store.update(job.id, {
          resultSummary: `Failed worktree cleanup ${new Date().toISOString()}`,
          worktreePath: undefined,
          branchName: undefined,
        });
      }
    }
    return cleaned;
  }

  private async runJob(initialJob: Job): Promise<void> {
    let job = initialJob;
    try {
      await this.notifier.jobStarted(job, this.supervisor.listActiveWorkers().length, config.workers.maxWorkers);
      await this.throwIfCancelled(job.id);
      if (job.jobType === "codex") {
        const activeWorker = this.supervisor.listActiveWorkers().find((worker) => worker.jobId === job.id);
        await runCodexForJob(job, activeWorker?.abortController.signal);
        job = await this.store.update(job.id, {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          resultSummary: "Codex root query completed.",
        });
      } else {
        const workspace = await createWorktree(job);
        job = await this.store.update(job.id, workspace);
        await writeJobLog(job.id, `Created worktree ${workspace.worktreePath} on ${workspace.branchName}`);

        await this.throwIfCancelled(job.id);
        const activeWorker = this.supervisor.listActiveWorkers().find((worker) => worker.jobId === job.id);
        await runCodexForJob(job, activeWorker?.abortController.signal);
        if (job.jobType === "moc_maintenance") {
          await assertMocIntegrity(job.worktreePath!);
        }
        if (["article", "daily_news", "daily_forecast", "image_maintenance"].includes(job.jobType ?? "article")) {
          const scope =
            job.jobType === "daily_news"
              ? "daily"
              : job.jobType === "daily_forecast"
                ? "forecasting"
                : (job.imageMaintenance?.scope ?? "all");
          await assertArticleImagePaths(job.worktreePath!, scope);
        }
        await this.throwIfCancelled(job.id);
        if (!(await hasDurableArticleChanges(job.worktreePath!))) {
          throw new Error("Codex produced no durable EBE article artifacts outside ignored working/runtime paths.");
        }

        const commitSha = await commitWorkerChanges(job);
        job = await this.store.update(job.id, { status: "waiting_publish", commitSha });
        await writeJobLog(job.id, `Worker commit ${commitSha}`);

        await this.throwIfCancelled(job.id);
        job = await this.store.update(job.id, { status: "publishing" });
        const pushedCommitSha = await publishWorkerBranch(job);
        job = await this.store.update(job.id, {
          status: "succeeded",
          pushedCommitSha,
          finishedAt: new Date().toISOString(),
          resultSummary: "Published to private repository.",
        });
        if (job.article) {
          const articleId = job.article.articleId;
          const sourcePath = await this.resolveCompletedArticlePath(job, pushedCommitSha);
          const reconciliation = await new ReconciliationService(config.paths.vaultRoot, new FilesystemArticleRepository(config.paths.vaultRoot), this.store).reconcileJob(job, sourcePath);
          if (reconciliation?.reviewRequired) throw new Error(`Article reconciliation review required: ${reconciliation.message}`);
          const canonicalSha = await publishCanonicalManagementState(); job = await this.store.update(job.id, { pushedCommitSha: canonicalSha, resultSummary: `Published article at ${pushedCommitSha}; canonical reconciliation at ${canonicalSha}.` });
          const reconciledArticle = await new FilesystemArticleRepository(config.paths.vaultRoot).getById(articleId);
          if (reconciledArticle?.autonomous?.candidateId) {
            await new CandidateRegistry(path.join(config.paths.vaultRoot, "canonical", "autonomous", "registry.json")).update(reconciledArticle.autonomous.candidateId, { status: "generated", articleId: reconciledArticle.id, jobId: job.id, lastAttemptAt: new Date().toISOString() });
            const indexService = new IndexService(config.paths.vaultRoot, new FilesystemArticleRepository(config.paths.vaultRoot)); await indexService.rebuildAll(); await new BuildService(config.paths.vaultRoot, new FilesystemArticleRepository(config.paths.vaultRoot), indexService).build();
          }
        }

        if (!config.workers.keepSuccessfulWorktrees && job.worktreePath && job.branchName) {
          await removeWorktree(job.worktreePath, job.branchName);
        }
      }
      await this.notifier.jobSucceeded(job);
    } catch (error) {
      const current = (await this.store.get(initialJob.id)) ?? job;
      const errorText = String(error);
      const failedStatus =
        errorText.toLowerCase().includes("cancelled") || errorText.toLowerCase().includes("aborted")
          ? "cancelled"
          : errorText.toLowerCase().includes("merge conflict") || errorText.toLowerCase().includes("reconciliation review required")
            ? "failed_review_required"
            : "failed";
      const updated = await this.store.update(initialJob.id, {
        status: failedStatus,
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
      if (updated.article) {
        const articles = new FilesystemArticleRepository(config.paths.vaultRoot); await new ReconciliationService(config.paths.vaultRoot, articles, this.store).reconcileJob(updated).catch(() => undefined);
        const failedArticle = await articles.getById(updated.article.articleId); if (failedArticle?.autonomous?.candidateId) await new CandidateRegistry(path.join(config.paths.vaultRoot, "canonical", "autonomous", "registry.json")).recordFailure(failedArticle.autonomous.candidateId, [60, 360, 1440, 10080]).catch(() => undefined);
      }
      await writeJobLog(initialJob.id, `FAILED\n${updated.errorMessage ?? String(error)}`);
      if (!config.workers.keepFailedWorktrees && current.worktreePath && current.branchName) {
        await removeWorktree(current.worktreePath, current.branchName).catch(() => undefined);
      }
      await this.notifier.jobFailed(updated, error);
    }
  }

  private async throwIfCancelled(jobId: string): Promise<void> {
    const job = await this.store.get(jobId);
    if (job?.cancelRequested) {
      throw new Error("Job cancelled by administrator.");
    }
  }

  private async resolveCompletedArticlePath(job: Job, pushedCommitSha: string): Promise<string | undefined> {
    if (!job.article) return undefined;
    try { await import("node:fs/promises").then((fs) => fs.access(path.join(config.paths.vaultRoot, job.article!.sourcePath))); return job.article.sourcePath; } catch { /* discover newly selected EBE path */ }
    const diff = await runGit(config.paths.vaultRoot, ["diff", "--name-only", `${pushedCommitSha}^1`, pushedCommitSha]);
    if (diff.code !== 0) return undefined; const candidates = diff.stdout.split(/\r?\n/).map((entry) => entry.trim().replace(/\\/g, "/")).filter((entry) => entry.startsWith("10_Published/") && entry.endsWith(".md") && !entry.endsWith("/_MOC.md")); return candidates.length === 1 ? candidates[0] : undefined;
  }
}
