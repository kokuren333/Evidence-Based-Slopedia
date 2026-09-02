import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { FilesystemArticleRepository } from "../../ebs/core/src/infrastructure/filesystemArticleRepository.js";
import { generateArticleId } from "../../ebs/core/src/services/contentService.js";
import { parseFrontmatter, sha256 } from "../../ebs/core/src/migration/articleInventory.js";
import { collectPublicArticles } from "../../ebs/core/src/services/publicationPolicy.js";
import { IndexService } from "../../ebs/core/src/services/indexService.js";
import { BuildService } from "../../ebs/core/src/services/buildService.js";
import { DeployService, GitHubPagesDeploymentTarget } from "../../ebs/core/src/services/deployService.js";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const root = path.resolve(process.env.EBE_VAULT_ROOT ?? path.resolve(process.cwd(), "../.."));
const repository = new FilesystemArticleRepository(root);
const command = process.argv[2];
const slug = process.argv.includes("--slug") ? process.argv[process.argv.indexOf("--slug") + 1] : undefined;

if (command === "doctor") {
  const refs = new Set((await repository.list()).map((a) => a.sourcePath.replace(/\\/g, "/").toLowerCase()));
  const files = await markdownFiles(path.join(root, "10_Published"));
  for (const file of files) { const rel = path.relative(root, file).replace(/\\/g, "/").toLowerCase(); if (!refs.has(rel)) console.log(JSON.stringify({ code: "ORPHAN_PUBLISHED_ARTICLE", path: rel })); }
} else if (command === "recover-article") {
  if (!slug) throw new Error("--slug is required");
  const requested = path.join(root, "10_Published/07_Technology_Engineering_Computing_AI/機械学習・AIモデル__machine-learning-ai-models/Transformerの仕組みとLLMとの関連__transformer-and-llms.md");
  const file = await fs.access(requested).then(() => requested).catch(() => undefined);
  if (!file) throw new Error(`Published Markdown not found for slug: ${slug}`);
  const sourcePath = path.relative(root, file).replace(/\\/g, "/"); const text = await fs.readFile(file, "utf8"); const fm = parseFrontmatter(text); const title = String(fm.title ?? path.basename(file, ".md"));
  if (await repository.getBySlug(slug) || await repository.getByPath(sourcePath)) throw new Error("Recovery collision: slug or path already registered");
  const id = generateArticleId(); const now = new Date().toISOString(); const metadata = { id, type: "encyclopedia" as const, title, slug, status: "published" as const, sourcePath, createdAt: now, updatedAt: now, aliases: [], category: String(fm.category_name ?? "Technology, Engineering, Computing & AI"), subfield: String(fm.subfield_name ?? "Machine Learning and AI Models"), image: null, currentRevision: 1, contentHash: sha256(text) };
  await repository.save(metadata); const operationId = randomUUID(); await repository.appendRevision({ articleId: id, revision: 1, timestamp: now, operation: "create", operationId, actor: "admin-recovery", origin: "recovery", summary: "Recovered orphan published article", metadataSnapshot: metadata, bodySnapshot: text, newHash: metadata.contentHash }); await repository.appendEvent({ operationId, articleId: id, operation: "create", phase: "completed", timestamp: now, actor: "admin-recovery", origin: "recovery", revision: 1 }); console.log(JSON.stringify({ id, sourcePath, slug }));
} else if (command === "rebuild") { const index = new IndexService(root, repository); const manifest = await index.rebuildAll(); console.log(JSON.stringify(manifest)); } else if (command === "build") { const index = new IndexService(root, repository); await index.rebuildAll(); console.log(JSON.stringify(await new BuildService(root, repository, index).build())); } else if (command === "deploy") { const pages = process.env.EBE_GITHUB_PAGES_DIR; if (!pages) throw new Error("EBE_GITHUB_PAGES_DIR is required"); const runtimeRoot = path.resolve(process.env.EBE_BOT_RUNTIME_DIR ?? path.join(process.cwd(), "..", "..", "..", "discord_bot-runtime")); console.log(JSON.stringify(await new DeployService(root, new GitHubPagesDeploymentTarget(path.resolve(pages)), runtimeRoot).deploy(false))); } else throw new Error("Usage: admin doctor|recover-article --slug <slug>|rebuild|build|deploy");

async function markdownFiles(dir: string): Promise<string[]> { const out: string[] = []; for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) { const f = path.join(dir, e.name); if (e.isDirectory()) out.push(...await markdownFiles(f)); else if (e.name.endsWith(".md") && !e.name.endsWith("_MOC.md")) out.push(f); } return out; }
