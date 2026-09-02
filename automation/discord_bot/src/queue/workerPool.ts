import { config } from "../config.js";
import path from "node:path";
import fs from "node:fs/promises";
import { commitWorkerChanges, publishWorkerBranch } from "../runners/gitPublisher.js";
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
import { ImageService } from "../../../ebs/core/src/services/imageService.js";
import { DeployService, GitHubPagesDeploymentTarget } from "../../../ebs/core/src/services/deployService.js";
import { ContentService } from "../../../ebs/core/src/services/contentService.js";

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

  async cleanupFailedWorktrees(olderThanDays: number, dryRun: boolean): Promise<{ worktrees: string[]; jobs: string[]; logs: string[]; jobRecords: string[] }> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const allJobs = await this.store.all();
    const targets = allJobs.filter((job) => {
      if (!["succeeded", "failed", "failed_review_required", "cancelled"].includes(job.status)) return false;
      const finishedAt = job.finishedAt ?? job.updatedAt;
      return new Date(finishedAt).getTime() <= cutoff;
    });
    const worktrees: string[] = []; const jobIds: string[] = []; const logs: string[] = []; const jobRecords: string[] = [];
    for (const job of targets) {
      if (job.worktreePath && job.branchName) worktrees.push(`${job.id}: ${job.worktreePath}`); jobIds.push(job.id); jobRecords.push(job.id);
      const jobLogs = (await fs.readdir(config.paths.logDir).catch(() => [])).filter((file) => file.includes(job.id)).map((file) => path.join(config.paths.logDir, file));
      logs.push(...jobLogs);
      if (!dryRun) {
        if (job.worktreePath && job.branchName) await removeWorktree(job.worktreePath, job.branchName).catch((error) =>
          writeJobLog(job.id, `cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        for (const file of jobLogs) await fs.rm(file, { force: true });
        await this.store.remove(job.id);
      }
    }
    return { worktrees, jobs: jobIds, logs, jobRecords };
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
        const requiredArtifactPrefix = job.jobType === "daily_news" ? "11_Daily/" : job.jobType === "daily_forecast" ? "12_Forecasting/" : "10_Published/";
        if (!(await hasDurableArticleChanges(job.worktreePath!, job.baseCommit, requiredArtifactPrefix))) {
          throw new Error("Codex produced no durable EBE article artifacts outside ignored working/runtime paths.");
        }

        if (job.article) {
          const workerArticles = new FilesystemArticleRepository(job.worktreePath!, { eventsFile: config.paths.managementEventsFile });
          const completedSourcePath = await this.resolveWorkerArticlePath(job);
          if (!completedSourcePath) throw new Error("Published article source could not be identified in worker changes.");
          const operationId = job.article.operationId;
          if (!operationId) throw new Error(`Article operation ID missing: ${job.article.articleId}`);
          const content = new ContentService(job.worktreePath!, workerArticles);
          await content.completeQueuedGeneration(job.article.articleId, job.article.operation, operationId, { actor: "worker", origin: "publish-finalize", jobId: job.id }, completedSourcePath);
          const completed = await workerArticles.getById(job.article.articleId);
          if (!completed) throw new Error(`Article metadata missing after reconciliation: ${job.article.articleId}`);
          if (completed.status !== "published") {
            await content.publish(completed.id, { actor: "worker", origin: "publish-finalize", jobId: job.id });
          }
          await new IndexService(job.worktreePath!, workerArticles).rebuildAll();
          if (completed?.autonomous?.candidateId) {
            const workerRegistry = new CandidateRegistry(path.join(job.worktreePath!, "canonical", "autonomous", "registry.json"));
            const controlRegistry = new CandidateRegistry(path.join(config.paths.runtimeDir, "autonomous", "registry.json"));
            const candidate = await controlRegistry.get(completed.autonomous.candidateId);
            if (candidate) await workerRegistry.upsert(candidate);
            await workerRegistry.update(completed.autonomous.candidateId, { status: "generated", articleId: completed.id, jobId: job.id, lastAttemptAt: new Date().toISOString() });
          }
        }

        const commitSha = await commitWorkerChanges(job);
        job = await this.store.update(job.id, { status: "waiting_publish", commitSha });
        await writeJobLog(job.id, `Worker commit ${commitSha}`);

        await this.throwIfCancelled(job.id);
        job = await this.store.update(job.id, { status: "publishing" });
        const pushedCommitSha = await publishWorkerBranch(job);
        if (config.autoDeploy.enabled && ["article", "daily_news", "daily_forecast", "image_maintenance"].includes(job.jobType ?? "article")) {
          const pagesDirectory = process.env.EBS_GITHUB_PAGES_DIR;
          if (!pagesDirectory) throw new Error("Automatic deployment is enabled but EBS_GITHUB_PAGES_DIR is not configured.");
          const repository = new FilesystemArticleRepository(config.paths.vaultRoot, { eventsFile: config.paths.managementEventsFile });
          const indexes = new IndexService(config.paths.vaultRoot, repository);
          await indexes.rebuildAll();
          await new BuildService(config.paths.vaultRoot, repository, indexes).build();
          const deployment = new DeployService(config.paths.vaultRoot, new GitHubPagesDeploymentTarget(path.resolve(pagesDirectory)), config.paths.runtimeDir);
          const result = await deployment.deploy(false);
          if (result.result !== "succeeded") throw new Error(`Site deployment failed${result.error ? `: ${result.error}` : "."}`);
        }

        await this.throwIfCancelled(job.id);
        job = await this.store.update(job.id, { status: "succeeded", pushedCommitSha, finishedAt: new Date().toISOString(), resultSummary: `Published article at ${pushedCommitSha}; rebuild and deployment completed.` });

        if (!config.workers.keepSuccessfulWorktrees && job.worktreePath && job.branchName) {
          await removeWorktree(job.worktreePath, job.branchName);
        }
      }
      await this.notifier.jobSucceeded(job);
    } catch (error) {
      const current = await this.store.get(initialJob.id);
      if (!current) return;
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
      // Failure reconciliation is worker-owned state.  Writing it to the vault
      // checkout here dirties main and makes the publish preflight reject the
      // next (otherwise unrelated) worker.  If the worker checkout is gone,
      // the durable job state above is the recovery record; startup recovery is
      // deliberately read-only (see index.ts).
      if (updated.article && current.worktreePath) {
        try {
          await fs.access(current.worktreePath);
          const articles = new FilesystemArticleRepository(current.worktreePath, { eventsFile: config.paths.managementEventsFile });
          await new ReconciliationService(current.worktreePath, articles, this.store).reconcileJob(updated).catch(() => undefined);
          const failedArticle = await articles.getById(updated.article.articleId);
          if (failedArticle?.autonomous?.candidateId) {
            const workerRegistry = new CandidateRegistry(path.join(current.worktreePath, "canonical", "autonomous", "registry.json"));
            const controlRegistry = new CandidateRegistry(path.join(config.paths.runtimeDir, "autonomous", "registry.json"));
            const candidate = await controlRegistry.get(failedArticle.autonomous.candidateId);
            if (candidate) await workerRegistry.upsert(candidate);
            await workerRegistry.recordFailure(failedArticle.autonomous.candidateId, [60, 360, 1440, 10080]).catch(() => undefined);
          }
        } catch {
          // Missing worker trees are expected after cleanup; do not fall back
          // to mutating the main vault.
        }
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
    if (!job || job.status === "cancelled" || job.cancelRequested) {
      throw new Error("Job cancelled by administrator.");
    }
  }

  private async resolveCompletedArticlePath(job: Job, pushedCommitSha: string): Promise<string | undefined> {
    if (!job.article) return undefined;
    try { await import("node:fs/promises").then((fs) => fs.access(path.join(config.paths.vaultRoot, job.article!.sourcePath))); return job.article.sourcePath; } catch { /* discover newly selected EBE path */ }
    const diff = await runGit(config.paths.vaultRoot, ["diff", "--name-only", `${pushedCommitSha}^1`, pushedCommitSha]);
    if (diff.code !== 0) return undefined; const candidates = diff.stdout.split(/\r?\n/).map((entry) => entry.trim().replace(/\\/g, "/")).filter((entry) => entry.startsWith("10_Published/") && entry.endsWith(".md") && !entry.endsWith("/_MOC.md")); return candidates.length === 1 ? candidates[0] : undefined;
  }

  private async resolveWorkerArticlePath(job: Job): Promise<string | undefined> {
    if (!job.worktreePath || !job.article) return undefined;
    const baseCommit = job.baseCommit;
    if (!baseCommit) {
      throw new Error(`Missing baseCommit for job ${job.id}`);
    }
    const diff = await runGit(job.worktreePath, ["diff", "--name-only", baseCommit, "HEAD"]);
    if (diff.code !== 0) return undefined;
    const candidates = diff.stdout.split(/\r?\n/).map((entry) => entry.trim().replace(/\\/g, "/"))
      .filter((entry) => entry.startsWith("10_Published/") && entry.endsWith(".md") && !entry.endsWith("/_MOC.md"));
    return candidates.length === 1 ? candidates[0] : (await fs.access(path.join(job.worktreePath, job.article.sourcePath)).then(() => job.article!.sourcePath).catch(() => undefined));
  }
}
