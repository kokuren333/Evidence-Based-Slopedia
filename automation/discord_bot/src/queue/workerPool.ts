import { config } from "../config.js";
import path from "node:path";
import fs from "node:fs/promises";
import { removeUnresolvedImageReferences } from "../runners/imagePathChecker.js";
import { assertMocIntegrity } from "../runners/mocIntegrityChecker.js";
import { hasDurableArticleChanges } from "../runners/publishGateChecker.js";
import { runCodexForJob } from "../runners/codexRunner.js";
import { createWorktree, removeWorktree } from "../runners/workspaceManager.js";
import { canStartWorker } from "../services/resourceGuard.js";
import { writeJobLog } from "../services/logWriter.js";
import type { Job } from "../types.js";
import type { JobPhase } from "../../../ebs/core/src/domain/job.js";
import type { JobStore } from "./jobStore.js";
import type { Notifier } from "../services/notifier.js";
import { WorkerSupervisor } from "../../../ebs/core/src/services/workerSupervisor.js";
import { FilesystemArticleRepository } from "../../../ebs/core/src/infrastructure/filesystemArticleRepository.js";
import { ReconciliationService } from "../../../ebs/core/src/services/reconciliationService.js";
import { promoteGeneratedContent } from "../services/contentPromotion.js";
import { runGit } from "../utils/shell.js";
import { CandidateRegistry } from "../../../ebs/core/src/services/candidateRegistry.js";
import { IndexService } from "../../../ebs/core/src/services/indexService.js";
import { BuildService } from "../../../ebs/core/src/services/buildService.js";
import { ImageService } from "../../../ebs/core/src/services/imageService.js";
import { DeployService, GitHubPagesDeploymentTarget } from "../../../ebs/core/src/services/deployService.js";
import { ContentService } from "../../../ebs/core/src/services/contentService.js";
import { collectPublicArticles } from "../../../ebs/core/src/services/publicationPolicy.js";
import { isArticleSource } from "../../../ebs/core/src/infrastructure/contentPaths.js";
import { parseFrontmatter } from "../../../ebs/core/src/migration/articleInventory.js";

export class WorkerPool {
  private timer: NodeJS.Timeout | undefined;
  private publicationTail: Promise<void> = Promise.resolve();
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
        await this.store.update(job.id, { cleanupResult: { worktreeRemoved: Boolean(job.worktreePath && job.branchName), logsRetained: jobLogs.length, jobRecordRetained: true } }).catch(() => undefined);
      }
    }
    return { worktrees, jobs: jobIds, logs, jobRecords };
  }

  private async runJob(initialJob: Job): Promise<void> {
    let job = initialJob;
    const phase = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      const started = new Date().toISOString();
      const phaseName = normalizePhase(name);
      await this.store.update(initialJob.id, { currentPhase: phaseName, phaseStartedAt: started, contentRoot: config.paths.contentRoot, publicUrl: config.autoDeploy.publicUrl }).catch(() => undefined);
      await writeJobLog(initialJob.id, JSON.stringify({ type: "job.phase.started", phase: phaseName, timestamp: started, contentRoot: config.paths.contentRoot })).catch(() => undefined);
      try {
        const result = await action();
        const completed = new Date().toISOString();
        await this.store.update(initialJob.id, { currentPhase: phaseName, lastSuccessfulPhase: phaseName, phaseCompletedAt: completed }).catch(() => undefined);
        await writeJobLog(initialJob.id, JSON.stringify({ type: "job.phase.succeeded", phase: phaseName, timestamp: completed, result: phaseResult(result) })).catch(() => undefined);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error); const failedAt = new Date().toISOString();
        await this.store.update(initialJob.id, { currentPhase: phaseName, failedAt, errorCode: errorCode(message), errorMessage: message, errorDetails: message, retryable: true }).catch(() => undefined);
        await writeJobLog(initialJob.id, JSON.stringify({ type: "job.phase.failed", phase: phaseName, timestamp: failedAt, errorCode: errorCode(message), error: message })).catch(() => undefined);
        throw error;
      }
    };
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
          const targetArticlePaths = job.jobType === "article"
            ? await changedPublishedArticlePaths(job.worktreePath!, job.baseCommit)
            : undefined;
          await removeUnresolvedImageReferences(job.worktreePath!, scope, targetArticlePaths);
        }
        await this.throwIfCancelled(job.id);
        const requiredArtifactPrefix = job.jobType === "daily_news" ? "11_Daily/" : job.jobType === "daily_forecast" ? "12_Forecasting/" : "10_Published/";
        if (!(await hasDurableArticleChanges(job.worktreePath!, job.baseCommit, requiredArtifactPrefix))) {
          throw new Error("Codex produced no durable EBE article artifacts outside ignored working/runtime paths.");
        }

        if (job.jobType === "article" && job.mode === "new" && !job.article) {
          const canonical = await phase("canonicalizing", () => canonicalizeNewArticle(job));
          job = await this.store.update(job.id, { article: canonical, canonicalized: true });
        }

        if (job.article && !job.canonicalized) {
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
          await assertCanonicalPublishReady(job.worktreePath!, workerArticles, completed.id);
          await new IndexService(job.worktreePath!, workerArticles).rebuildAll();
          const indexed = (await collectPublicArticles(job.worktreePath!, workerArticles)).publicArticles.some(({ metadata }) => metadata.id === completed.id && metadata.slug === completed.slug);
          if (!indexed) throw new Error(`Published article ${completed.id} was not registered in the public index.`);
          if (completed?.autonomous?.candidateId) {
            const workerRegistry = new CandidateRegistry(path.join(job.worktreePath!, "canonical", "autonomous", "registry.json"));
            const controlRegistry = new CandidateRegistry(path.join(config.paths.runtimeDir, "autonomous", "registry.json"));
            const candidate = await controlRegistry.get(completed.autonomous.candidateId);
            if (candidate) await workerRegistry.upsert(candidate);
            await workerRegistry.update(completed.autonomous.candidateId, { status: "generated", articleId: completed.id, jobId: job.id, lastAttemptAt: new Date().toISOString() });
          }
        }

        const promotionPaths = await changedContentPaths(job.worktreePath!, job.baseCommit);
        await writeJobLog(job.id, JSON.stringify({ phase: "promotion", event: "targets", timestamp: new Date().toISOString(), paths: promotionPaths }));
        await promoteGeneratedContent(job.worktreePath!, config.paths.contentRoot, promotionPaths);
        await writeJobLog(job.id, JSON.stringify({ phase: "promotion", event: "succeeded", timestamp: new Date().toISOString(), targetCount: promotionPaths.length }));

        await writeJobLog(job.id, JSON.stringify({ phase: "source_git", event: "skipped", timestamp: new Date().toISOString(), reason: "content-only job; ContentRoot is canonical" }));
        job = await this.store.update(job.id, { status: "waiting_publish" });
        await this.throwIfCancelled(job.id);
        job = await this.store.update(job.id, { status: "publishing" });
        if (config.autoDeploy.enabled && ["article", "daily_news", "daily_forecast", "image_maintenance"].includes(job.jobType ?? "article")) {
          await this.enqueuePublication(async () => {
          await writeJobLog(job.id, JSON.stringify({ phase: "deploy_config", event: "resolved", timestamp: new Date().toISOString(), autoDeploy: config.autoDeploy.enabled, pagesDirectory: process.env.EBS_GITHUB_PAGES_DIR, vaultRoot: config.paths.vaultRoot }));
          const pagesDirectory = process.env.EBS_GITHUB_PAGES_DIR;
          if (!pagesDirectory) throw new Error("Automatic deployment is enabled but EBS_GITHUB_PAGES_DIR is not configured.");
          const repository = new FilesystemArticleRepository(config.paths.contentRoot, { eventsFile: path.join(config.paths.runtimeDir, "content-management-events.jsonl") });
          const indexes = new IndexService(config.paths.contentRoot, repository);
          await phase("rebuild", () => indexes.rebuildAll());
          await phase("dist_build_and_validation", () => new BuildService(config.paths.contentRoot, repository, indexes, { basePath: process.env.EBS_SITE_BASE_PATH ?? "/", origin: process.env.EBS_SITE_ORIGIN }, config.paths.contentRoot).build());
          const deployment = new DeployService(config.paths.contentRoot, new GitHubPagesDeploymentTarget(path.resolve(pagesDirectory)), config.paths.runtimeDir);
          const result = await phase("pages_sync_commit_push", () => deployment.deploy(false));
          if (result.result !== "succeeded") throw new Error(`Site deployment failed${result.error ? `: ${result.error}` : "."}`);
          if (!result.remoteRevision || !/^[0-9a-f]{40}$/.test(result.remoteRevision)) throw new Error("Pages deployment returned no verified commit SHA.");
          await writeJobLog(job.id, JSON.stringify({ phase: "pages_sync_commit_push", event: "verified", timestamp: new Date().toISOString(), repository: path.resolve(pagesDirectory), commitSha: result.remoteRevision }));
          job = await this.store.update(job.id, { pagesCommitSha: result.remoteRevision, pagesUrl: config.autoDeploy.publicUrl });
          });
        }

        await this.throwIfCancelled(job.id);
        job = await this.store.update(job.id, { status: "succeeded", finishedAt: new Date().toISOString(), resultSummary: job.pagesCommitSha ? `Published to Pages at ${job.pagesCommitSha}; rebuild and deployment completed.` : "Content generated; deployment was not enabled." });

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
          const articles = new FilesystemArticleRepository(config.paths.contentRoot, { eventsFile: path.join(config.paths.runtimeDir, "content-management-events.jsonl") });
          await new ReconciliationService(config.paths.contentRoot, articles, this.store).reconcileJob(updated).catch(() => undefined);
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
    if (diff.code !== 0) return undefined; const candidates = diff.stdout.split(/\r?\n/).map((entry) => entry.trim().replace(/\\/g, "/")).filter((entry) => entry.startsWith("10_Published/") && isArticleSource(entry)); return candidates.length === 1 ? candidates[0] : undefined;
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
      .filter((entry) => entry.startsWith("10_Published/") && isArticleSource(entry));
    return candidates.length === 1 ? candidates[0] : (await fs.access(path.join(job.worktreePath, job.article.sourcePath)).then(() => job.article!.sourcePath).catch(() => undefined));
  }
}

function normalizePhase(name: string): JobPhase { const value: Record<string, JobPhase> = { source_git: "validating", deploy_config: "deploying", rebuild: "rebuilding", dist_build_and_validation: "building", pages_sync_commit_push: "deploying", promotion: "promoting" }; return value[name] ?? (name as JobPhase); }
function errorCode(message: string): string { if (/source.*metadata|hash mismatch/i.test(message)) return "ARTICLE_METADATA_SOURCE_MISMATCH"; if (/missing.*HTML/i.test(message)) return "DEPLOYMENT_VALIDATION_FAILED"; if (/cancel/i.test(message)) return "JOB_CANCELLED"; return "JOB_PHASE_FAILED"; }

function phaseResult(value: unknown): unknown {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return { result: record.result, remoteRevision: record.remoteRevision, articleCount: record.articleCount };
  }

  private async enqueuePublication<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.publicationTail;
    let release!: () => void;
    this.publicationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  return typeof value === "string" ? value : undefined;
}

/** Promote only a successfully validated temporary worktree into canonical ContentRoot. */
async function changedPublishedArticlePaths(cwd: string, baseCommit?: string): Promise<string[]> {
  const args = ["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=ACMR", "-z"];
  const results = await Promise.all([
    runGit(cwd, baseCommit ? [...args, baseCommit, "HEAD"] : [...args, "HEAD"]),
    runGit(cwd, ["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=ACMR", "-z"]),
    runGit(cwd, ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set(results.flatMap((result) => result.stdout.split("\0")))].map((file) => file.replace(/\\/g, "/"))
    .filter((file) => file.startsWith("10_Published/") && isArticleSource(file));
}

async function changedContentPaths(cwd: string, baseCommit?: string): Promise<string[]> {
  const args = ["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=ACMR", "-z"];
  const results = await Promise.all([
    baseCommit
      ? runGit(cwd, [...args, baseCommit, "HEAD"])
      : runGit(cwd, [...args, "HEAD"]),
    runGit(cwd, [...args]),
    runGit(cwd, ["-c", "core.quotepath=false", "ls-files", "--others", "-z"]),
  ]);
  const allowed = ["10_Published/", "11_Daily/", "12_Forecasting/", "50_Assets/", "canonical/metadata/", "canonical/revisions/"];
  return [...new Set(results.flatMap((result) => result.stdout.split("\0")))]
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => allowed.some((root) => file.startsWith(root)));
}

async function assertCanonicalPublishReady(root: string, repository: FilesystemArticleRepository, articleId: string): Promise<void> {
  const article = await repository.getById(articleId);
  if (!article) throw new Error(`Canonical article metadata missing: ${articleId}`);
  const source = path.join(root, article.sourcePath);
  await fs.access(source);
  if (article.status !== "published") throw new Error(`Canonical article is not published: ${article.status}`);
  if (!(await repository.history(articleId)).length) throw new Error(`Canonical revision missing: ${articleId}`);
}

async function canonicalizeNewArticle(job: Job): Promise<NonNullable<Job["article"]>> {
  const sourcePath = await changedPublishedArticlePaths(job.worktreePath!, job.baseCommit);
  if (sourcePath.length !== 1) throw new Error(`NEW_ARTICLE_IDENTITY_AMBIGUOUS: expected one article source, found ${sourcePath.length}`);
  const relative = sourcePath[0];
  const body = await fs.readFile(path.join(job.worktreePath!, relative), "utf8");
  const frontmatter = parseFrontmatter(body);
  const title = String(frontmatter.title ?? "").trim();
  const slug = String(frontmatter.slug ?? relative.split("/").pop()?.replace(/\.md$/i, "").split("__").at(-1) ?? "").trim();
  if (!title || !slug || slug.includes("\\") || slug.startsWith("/") || slug.includes("..")) throw new Error("NEW_ARTICLE_IDENTITY_INVALID: title and safe slug are required");
  const workerRepository = new FilesystemArticleRepository(job.worktreePath!, { eventsFile: path.join(job.worktreePath!, "canonical", "events", "management-events.jsonl") });
  const content = new ContentService(job.worktreePath!, workerRepository);
  const article = await content.create({ title, slug, category: String(frontmatter.category_name ?? frontmatter.category ?? ""), subfield: String(frontmatter.subfield_name ?? frontmatter.subfield ?? ""), sourcePath: relative, context: { actor: "worker", origin: "canonicalization", jobId: job.id } });
  const published = await content.publish(article.id, { actor: "worker", origin: "canonicalization", jobId: job.id });
  return { articleId: published.id, operation: "create", sourcePath: published.sourcePath, title: published.title, slug: published.slug, contentHash: published.contentHash, revision: published.currentRevision };
}
