import { generateArticleSlug, normalizeTitle, type ArticleMetadata } from "../domain/article.js";
import type { ArticleRepository } from "../ports/articleRepository.js";
import { CandidateRegistry, type TopicCandidate, type TopicSourceType } from "./candidateRegistry.js";

export interface WikipediaSeed { title: string; pageId?: number; url: string; summary: string; type?: string; }
export interface WikipediaClient { random(language: string): Promise<WikipediaSeed>; }
export interface SemanticDeduplicator { similarity(candidate: { title: string; summary?: string }, article: ArticleMetadata): Promise<number>; judge?(candidate: string, article: ArticleMetadata): Promise<"same" | "overlapping" | "distinct">; }
export interface NormalizedTopic { canonicalTopic: string; preferredTitle: string; aliases: string[]; proposedCategory?: string; sourceSeed?: string; }

export class TopicNormalizer {
  normalize(raw: string, category?: string, sourceSeed?: string): NormalizedTopic {
    const preferredTitle = raw.normalize("NFKC").trim().replace(/^(初心者向けに|わかりやすく)/, "").replace(/(を)?詳しく説明(する)?$/, "").trim();
    return { canonicalTopic: normalizeTitle(preferredTitle), preferredTitle, aliases: raw === preferredTitle ? [] : [raw], proposedCategory: category, sourceSeed };
  }
}

export class TopicDiscoveryService {
  constructor(private readonly articles: ArticleRepository, private readonly registry: CandidateRegistry, private readonly wikipedia?: WikipediaClient, private readonly semantic?: SemanticDeduplicator, private readonly normalizer = new TopicNormalizer(), private readonly thresholds = { duplicate: 0.9, review: 0.8 }) {}
  async fromExisting(): Promise<TopicCandidate[]> {
    const publicArticles = (await this.articles.list()).filter((article) => article.status === "published").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    if (!publicArticles.length) return [];
    const seed = publicArticles[0];
    const topics = [`${seed.title}の前提概念`, `${seed.title}の応用`, `${seed.title}と関連技術の比較`];
    return Promise.all(topics.map((topic) => this.evaluate(topic, "existing_article", seed.id, seed.category)));
  }
  async fromWikipedia(languages = ["ja", "en"]): Promise<TopicCandidate> {
    if (!this.wikipedia) throw new Error("Wikipedia client is unavailable");
    let lastError: unknown;
    for (const language of languages) try { const seed = await this.wikipedia.random(language); const unsuitable = this.wikipediaRejection(seed); if (unsuitable) return this.registry.add({ rawTopic: seed.title, ...this.normalizedFields(seed.title), aliases: [], sourceType: "wikipedia_random", sourceReference: seed.url, rejectionReason: unsuitable, status: "rejected" }); return this.evaluate(seed.title, "wikipedia_random", seed.url); } catch (error) { lastError = error; }
    throw lastError ?? new Error("Wikipedia discovery failed");
  }
  async evaluate(rawTopic: string, sourceType: TopicSourceType, sourceReference?: string, category?: string): Promise<TopicCandidate> {
    const normalized = this.normalizer.normalize(rawTopic, category, sourceReference);
    const existingCandidate = await this.registry.findNormalized(normalized.canonicalTopic);
    if (existingCandidate) return existingCandidate;
    const articles = await this.articles.list();
    const slug = generateArticleSlug(category, normalized.preferredTitle);
    const deterministic = articles.find((article) => article.title === normalized.preferredTitle || normalizeTitle(article.title) === normalized.canonicalTopic || article.slug === slug || article.aliases.some((alias) => normalizeTitle(alias) === normalized.canonicalTopic));
    if (deterministic) return this.registry.add({ rawTopic, ...this.normalizedFields(normalized.preferredTitle, normalized.canonicalTopic), aliases: normalized.aliases, proposedCategory: category, sourceType, sourceReference, status: "duplicate", rejectionReason: "deterministic_duplicate", similarityTarget: deterministic.id, similarityScore: 1 });
    if (this.semantic) for (const article of articles) { const score = await this.semantic.similarity({ title: normalized.preferredTitle }, article); if (score >= this.thresholds.duplicate) return this.registry.add({ rawTopic, ...this.normalizedFields(normalized.preferredTitle, normalized.canonicalTopic), aliases: normalized.aliases, proposedCategory: category, sourceType, sourceReference, status: "duplicate", rejectionReason: "semantic_duplicate", similarityTarget: article.id, similarityScore: score }); if (score >= this.thresholds.review && this.semantic.judge && await this.semantic.judge(normalized.preferredTitle, article) === "same") return this.registry.add({ rawTopic, ...this.normalizedFields(normalized.preferredTitle, normalized.canonicalTopic), aliases: normalized.aliases, proposedCategory: category, sourceType, sourceReference, status: "duplicate", rejectionReason: "semantic_judge_duplicate", similarityTarget: article.id, similarityScore: score }); }
    return this.registry.add({ rawTopic, ...this.normalizedFields(normalized.preferredTitle, normalized.canonicalTopic), aliases: normalized.aliases, proposedCategory: category, sourceType, sourceReference, status: "accepted" });
  }
  private normalizedFields(title: string, normalizedTopic = normalizeTitle(title)) { return { normalizedTopic, preferredTitle: title }; }
  private wikipediaRejection(seed: WikipediaSeed): string | undefined { if (seed.type === "disambiguation" || /曖昧さ回避|一覧$/.test(seed.title)) return "unsuitable_page_type"; if (/^\d{3,4}年$/.test(seed.title)) return "year_page"; if (seed.summary.trim().length < 80) return "short_stub"; return undefined; }
}

export class HttpWikipediaClient implements WikipediaClient {
  constructor(private readonly timeoutMs = 8000, private readonly retries = 2) {}
  async random(language: string): Promise<WikipediaSeed> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) try { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); const response = await fetch(`https://${language}.wikipedia.org/api/rest_v1/page/random/summary`, { signal: controller.signal, headers: { "user-agent": "Evidence-Based-Slopedia/0.1 topic-discovery" } }); clearTimeout(timer); if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`); const data = await response.json() as { title: string; pageid?: number; extract?: string; type?: string; content_urls?: { desktop?: { page?: string } } }; return { title: data.title, pageId: data.pageid, summary: data.extract ?? "", type: data.type, url: data.content_urls?.desktop?.page ?? `https://${language}.wikipedia.org/wiki/${encodeURIComponent(data.title)}` }; } catch (error) { last = error; if (attempt < this.retries) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt)); }
    throw last;
  }
}
