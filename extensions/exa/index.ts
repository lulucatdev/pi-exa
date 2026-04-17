import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type AuthMode = "x-api-key" | "bearer" | "none";
type ToolToggleName =
  | "search"
  | "answer"
  | "contents"
  | "codeContext"
  | "companyResearch"
  | "crawling"
  | "linkedinSearch"
  | "deepResearchStart"
  | "deepResearchCheck";
type DeepResearchStatus = "running" | "completed" | "error";

type ConfigFile = {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  authMode?: AuthMode;
  headers?: Record<string, string>;
  timeoutMs?: number;
  tools?: Partial<Record<ToolToggleName, boolean>>;
  defaults?: {
    searchNumResults?: number;
    textMaxCharacters?: number;
    highlightMaxCharacters?: number;
    codeContextTokens?: number | "dynamic";
    deepResearchNumResults?: number;
  };
};

type ResolvedConfig = {
  configPath: string;
  userConfigPath: string;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  authMode: AuthMode;
  headers: Record<string, string>;
  timeoutMs: number;
  tools: Record<ToolToggleName, boolean>;
  defaults: {
    searchNumResults: number;
    textMaxCharacters: number;
    highlightMaxCharacters: number;
    codeContextTokens: number | "dynamic";
    deepResearchNumResults: number;
  };
};

type SearchContentsParams = {
  includeText?: boolean;
  textMaxCharacters?: number;
  includeHtmlTags?: boolean;
  includeHighlights?: boolean;
  highlightQuery?: string;
  highlightMaxCharacters?: number;
  includeSummary?: boolean;
  summaryQuery?: string;
};

type DeepResearchJob = {
  id: string;
  query: string;
  mode: string;
  numResults: number;
  status: DeepResearchStatus;
  createdAt: string;
  updatedAt: string;
  resultText?: string;
  error?: string;
};

const SEARCH_TYPES = ["auto", "fast", "instant", "deep", "deep-reasoning", "keyword", "neural"] as const;
const SEARCH_CATEGORIES = ["company", "people", "tweet", "news"] as const;
const LIVECRAWL_MODES = ["always", "fallback", "never"] as const;
const COMPANY_RESEARCH_MODES = ["company", "news", "tweet", "people", "general"] as const;
const HOME_DIR = process.env.HOME;
const USER_CONFIG_PATH = HOME_DIR ? path.join(HOME_DIR, ".pi", "exa.config.json") : path.join(process.cwd(), ".pi", "exa.config.json");
const USER_JOBS_PATH = HOME_DIR ? path.join(HOME_DIR, ".pi", "exa.deep-research.jobs.json") : path.join(process.cwd(), ".pi", "exa.deep-research.jobs.json");

const TOOL_LABELS: Record<ToolToggleName, string> = {
  search: "exa-search",
  answer: "exa-answer",
  contents: "exa-contents",
  codeContext: "exa-code-context",
  companyResearch: "exa-company-research",
  crawling: "exa-crawl",
  linkedinSearch: "exa-linkedin-search",
  deepResearchStart: "exa-deep-research-start",
  deepResearchCheck: "exa-deep-research-check",
};

const DEFAULT_CONFIG: ResolvedConfig = {
  configPath: USER_CONFIG_PATH,
  userConfigPath: USER_CONFIG_PATH,
  baseUrl: "https://api.exa.ai",
  apiKey: "",
  apiKeyEnv: "EXA_API_KEY",
  authMode: "x-api-key",
  headers: {},
  timeoutMs: 30_000,
  tools: {
    search: true,
    answer: true,
    contents: true,
    codeContext: true,
    companyResearch: true,
    crawling: true,
    linkedinSearch: true,
    deepResearchStart: true,
    deepResearchCheck: true,
  },
  defaults: {
    searchNumResults: 5,
    textMaxCharacters: 4000,
    highlightMaxCharacters: 2000,
    codeContextTokens: "dynamic",
    deepResearchNumResults: 10,
  },
};

const deepResearchJobs = new Map<string, DeepResearchJob>();
let jobsHydrated = false;

function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function getConfigPaths() {
  return {
    userConfigPath: USER_CONFIG_PATH,
    writeConfigPath: USER_CONFIG_PATH,
    jobsPath: USER_JOBS_PATH,
  };
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function readConfigFile(filePath = getConfigPaths().writeConfigPath): ConfigFile {
  return readJsonFile<ConfigFile>(filePath, {});
}

function writeConfigFile(fileConfig: ConfigFile, filePath = getConfigPaths().writeConfigPath) {
  writeJsonFile(filePath, fileConfig);
}

function hydrateJobs() {
  if (jobsHydrated) return;
  jobsHydrated = true;

  const savedJobs = readJsonFile<DeepResearchJob[]>(getConfigPaths().jobsPath, []);
  for (const job of savedJobs) {
    const hydratedJob =
      job.status === "running"
        ? {
            ...job,
            status: "error" as const,
            error: job.error ?? "pi restarted before the deep research job finished.",
            updatedAt: new Date().toISOString(),
          }
        : job;
    deepResearchJobs.set(hydratedJob.id, hydratedJob);
  }

  persistJobs();
}

function persistJobs() {
  const jobs = Array.from(deepResearchJobs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  writeJsonFile(getConfigPaths().jobsPath, jobs);
}

function upsertJob(job: DeepResearchJob) {
  deepResearchJobs.set(job.id, job);
  persistJobs();
}

function listJobs(limit = 10): DeepResearchJob[] {
  hydrateJobs();
  return Array.from(deepResearchJobs.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

function getJob(jobId: string): DeepResearchJob | undefined {
  hydrateJobs();
  return deepResearchJobs.get(jobId);
}

function removeJob(jobId: string): boolean {
  hydrateJobs();
  const removed = deepResearchJobs.delete(jobId);
  if (removed) persistJobs();
  return removed;
}

function clearJobs(): number {
  hydrateJobs();
  const count = deepResearchJobs.size;
  deepResearchJobs.clear();
  persistJobs();
  return count;
}

function pruneJobs(predicate: (job: DeepResearchJob) => boolean): number {
  hydrateJobs();
  let removed = 0;
  for (const [jobId, job] of deepResearchJobs.entries()) {
    if (!predicate(job)) continue;
    deepResearchJobs.delete(jobId);
    removed += 1;
  }
  if (removed > 0) persistJobs();
  return removed;
}

function formatJobLine(job: DeepResearchJob): string {
  const tail = job.status === "error" ? ` - ${job.error}` : job.status === "completed" ? " - ready" : " - running";
  return `- ${job.id} [${job.status}] ${job.query}${tail}`;
}

function formatJobDetails(job: DeepResearchJob): string {
  const parts = [
    `id: ${job.id}`,
    `status: ${job.status}`,
    `mode: ${job.mode}`,
    `numResults: ${job.numResults}`,
    `createdAt: ${job.createdAt}`,
    `updatedAt: ${job.updatedAt}`,
    `query: ${job.query}`,
  ];

  if (job.error) parts.push(`error: ${job.error}`);
  if (job.resultText) parts.push(`\nresult:\n${job.resultText}`);
  return parts.join("\n");
}

function loadConfig(): ResolvedConfig {
  const paths = getConfigPaths();
  const fileConfig = readConfigFile(paths.userConfigPath);
  const apiKeyEnv = fileConfig.apiKeyEnv ?? DEFAULT_CONFIG.apiKeyEnv;
  const apiKey = expandEnv(fileConfig.apiKey ?? process.env[apiKeyEnv] ?? "");
  const headers = Object.fromEntries(
    Object.entries(fileConfig.headers ?? {}).map(([key, value]) => [key, expandEnv(value)]),
  );

  return {
    configPath: paths.writeConfigPath,
    userConfigPath: paths.userConfigPath,
    baseUrl: (fileConfig.baseUrl ?? DEFAULT_CONFIG.baseUrl).replace(/\/+$/, ""),
    apiKey,
    apiKeyEnv,
    authMode: fileConfig.authMode ?? DEFAULT_CONFIG.authMode,
    headers,
    timeoutMs: fileConfig.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    tools: {
      search: fileConfig.tools?.search ?? DEFAULT_CONFIG.tools.search,
      answer: fileConfig.tools?.answer ?? DEFAULT_CONFIG.tools.answer,
      contents: fileConfig.tools?.contents ?? DEFAULT_CONFIG.tools.contents,
      codeContext: fileConfig.tools?.codeContext ?? DEFAULT_CONFIG.tools.codeContext,
      companyResearch: fileConfig.tools?.companyResearch ?? DEFAULT_CONFIG.tools.companyResearch,
      crawling: fileConfig.tools?.crawling ?? DEFAULT_CONFIG.tools.crawling,
      linkedinSearch: fileConfig.tools?.linkedinSearch ?? DEFAULT_CONFIG.tools.linkedinSearch,
      deepResearchStart: fileConfig.tools?.deepResearchStart ?? DEFAULT_CONFIG.tools.deepResearchStart,
      deepResearchCheck: fileConfig.tools?.deepResearchCheck ?? DEFAULT_CONFIG.tools.deepResearchCheck,
    },
    defaults: {
      searchNumResults: fileConfig.defaults?.searchNumResults ?? DEFAULT_CONFIG.defaults.searchNumResults,
      textMaxCharacters: fileConfig.defaults?.textMaxCharacters ?? DEFAULT_CONFIG.defaults.textMaxCharacters,
      highlightMaxCharacters:
        fileConfig.defaults?.highlightMaxCharacters ?? DEFAULT_CONFIG.defaults.highlightMaxCharacters,
      codeContextTokens: fileConfig.defaults?.codeContextTokens ?? DEFAULT_CONFIG.defaults.codeContextTokens,
      deepResearchNumResults:
        fileConfig.defaults?.deepResearchNumResults ?? DEFAULT_CONFIG.defaults.deepResearchNumResults,
    },
  };
}

function assertToolEnabled(config: ResolvedConfig, toolName: ToolToggleName) {
  if (!config.tools[toolName]) {
    throw new Error(
      `${TOOL_LABELS[toolName]} is disabled in ${config.configPath}. Run /reload after changing the config.`,
    );
  }
}

function buildHeaders(config: ResolvedConfig): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    ...config.headers,
  };

  if (config.authMode === "x-api-key") {
    if (!config.apiKey) {
      throw new Error(`Missing Exa API key. Export ${config.apiKeyEnv} or set apiKey in ${config.configPath}.`);
    }
    headers["x-api-key"] = config.apiKey;
  }

  if (config.authMode === "bearer") {
    if (!config.apiKey) {
      throw new Error(`Missing Exa API key. Export ${config.apiKeyEnv} or set apiKey in ${config.configPath}.`);
    }
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  return headers;
}

async function postJson(
  config: ResolvedConfig,
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const abort = () => controller.abort();

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: any = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const message = typeof parsed?.error === "string" ? parsed.error : text || response.statusText;
      throw new Error(`Exa request failed (${response.status} ${response.statusText}): ${message}`);
    }

    return parsed ?? {};
  } catch (error) {
    if (controller.signal.aborted && !(signal?.aborted)) {
      throw new Error(`Exa request timed out after ${config.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function cleanText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanText(item))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function formatBlock(title: string, value: unknown): string {
  const text = cleanText(value);
  if (!text) return "";
  return `${title}:\n${text}`;
}

function formatListBlock(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function formatSearchResult(result: Record<string, any>, index: number): string {
  const metadata: string[] = [];
  if (result.author) metadata.push(`Author: ${result.author}`);
  if (result.publishedDate) metadata.push(`Published: ${result.publishedDate}`);
  else if (result.date) metadata.push(`Date: ${result.date}`);
  if (typeof result.score === "number") metadata.push(`Score: ${result.score}`);
  if (result.domain) metadata.push(`Domain: ${result.domain}`);
  if (result.image) metadata.push(`Image: ${result.image}`);
  if (result.favicon) metadata.push(`Favicon: ${result.favicon}`);

  const parts = [
    `${index}. ${result.title || result.url || result.id || "Untitled result"}`,
    result.url ? `URL: ${result.url}` : result.id ? `ID: ${result.id}` : "",
    metadata.join(" | "),
    formatBlock("Summary", result.summary),
    formatBlock("Highlights", result.highlights),
    formatBlock("Text", result.text ?? result.content),
  ].filter(Boolean);

  return parts.join("\n");
}

function formatSearchResponse(response: any, notes: string[] = []): string {
  const results = Array.isArray(response?.results) ? response.results : [];
  const blocks: string[] = [];

  if (notes.length > 0) blocks.push(formatListBlock("Notes", notes));
  if (results.length === 0) blocks.push("No search results returned.");
  else {
    blocks.push(
      results
        .map((result: Record<string, any>, index: number) => formatSearchResult(result, index + 1))
        .join("\n\n---\n\n"),
    );
  }

  return blocks.filter(Boolean).join("\n\n");
}

function formatCitation(citation: Record<string, any>, index: number): string {
  const parts = [
    `${index}. ${citation.title || citation.url || "Untitled citation"}`,
    citation.url ? `URL: ${citation.url}` : "",
    citation.publishedDate ? `Published: ${citation.publishedDate}` : citation.date ? `Date: ${citation.date}` : "",
    citation.author ? `Author: ${citation.author}` : "",
  ].filter(Boolean);

  return parts.join("\n");
}

function formatAnswerResponse(response: any): string {
  const answerText = cleanText(response?.answer ?? response?.text ?? response?.content);
  const citations = Array.isArray(response?.citations)
    ? response.citations
    : Array.isArray(response?.sources)
      ? response.sources
      : Array.isArray(response?.results)
        ? response.results
        : [];

  const parts = [answerText || "No answer text returned."];
  if (citations.length > 0) {
    parts.push(
      "Citations:\n" +
        citations.map((item: Record<string, any>, index: number) => formatCitation(item, index + 1)).join("\n\n"),
    );
  }

  return parts.join("\n\n");
}

function formatContentsResult(result: Record<string, any>, index: number): string {
  const parts = [
    `${index}. ${result.title || result.url || result.id || "Untitled document"}`,
    result.url ? `URL: ${result.url}` : result.id ? `ID: ${result.id}` : "",
    formatBlock("Summary", result.summary),
    formatBlock("Highlights", result.highlights),
    formatBlock("Text", result.text ?? result.content),
  ].filter(Boolean);

  return parts.join("\n");
}

function formatContentsResponse(response: any, notes: string[] = []): string {
  const results = Array.isArray(response?.results)
    ? response.results
    : Array.isArray(response?.contents)
      ? response.contents
      : Array.isArray(response?.data)
        ? response.data
        : [];

  const parts: string[] = [];
  if (notes.length > 0) parts.push(formatListBlock("Notes", notes));

  if (results.length === 0) {
    const single = cleanText(response?.content ?? response?.text);
    parts.push(single || "No content returned.");
  } else {
    parts.push(
      results
        .map((result: Record<string, any>, index: number) => formatContentsResult(result, index + 1))
        .join("\n\n---\n\n"),
    );
  }

  return parts.filter(Boolean).join("\n\n");
}

function formatCodeContextResponse(response: any): string {
  const details: string[] = [];
  if (typeof response?.resultsCount === "number") details.push(`Results: ${response.resultsCount}`);
  if (typeof response?.outputTokens === "number") details.push(`Output tokens: ${response.outputTokens}`);
  if (typeof response?.searchTime === "number") details.push(`Search time: ${response.searchTime}s`);
  const costText = cleanText(response?.costDollars);
  if (costText) details.push(`Cost: ${costText}`);

  const parts = [details.length > 0 ? details.join(" | ") : "", cleanText(response?.response) || "No code context returned."];
  return parts.filter(Boolean).join("\n\n");
}

function formatDeepResearchResponse(response: any): string {
  const firstResult = Array.isArray(response?.results) ? response.results[0] : undefined;
  if (!firstResult || typeof firstResult !== "object") {
    return formatSearchResponse(response);
  }

  const parts = [
    formatBlock("Answer", firstResult.answer),
    firstResult.confidence != null ? `Confidence: ${firstResult.confidence}` : "",
    Array.isArray(firstResult.citations)
      ? formatListBlock(
          "Citations",
          firstResult.citations.map((citation: unknown) => cleanText(citation)).filter(Boolean),
        )
      : "",
    firstResult.fields ? formatBlock("Structured fields", firstResult.fields) : "",
  ].filter(Boolean);

  if (parts.length === 0) return formatSearchResponse(response);
  return parts.join("\n\n");
}

function finalizeOutput(text: string): string {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return text;

  let notice = `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
  notice += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  notice += " Narrow the query or lower numResults for a denser result.]";
  return truncation.content + notice;
}

function maskApiKey(apiKey: string): string {
  if (!apiKey) return "(missing)";
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}***${apiKey.slice(-1)}`;
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function buildSearchContents(params: SearchContentsParams, config: ResolvedConfig): Record<string, any> {
  const contents: Record<string, any> = {};

  if (params.includeText) {
    contents.text = {
      maxCharacters: params.textMaxCharacters ?? config.defaults.textMaxCharacters,
    };
    if (params.includeHtmlTags) contents.text.includeHtmlTags = true;
  }

  if (params.includeHighlights) {
    contents.highlights = {
      maxCharacters: params.highlightMaxCharacters ?? config.defaults.highlightMaxCharacters,
    };
    if (params.highlightQuery) contents.highlights.query = params.highlightQuery;
  }

  if (params.includeSummary) {
    contents.summary = params.summaryQuery ? { query: params.summaryQuery } : true;
  }

  return contents;
}

function buildSearchBody(
  params: SearchContentsParams & {
    query: string;
    type?: string;
    category?: string;
    numResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    startPublishedDate?: string;
    endPublishedDate?: string;
    maxAgeHours?: number;
    livecrawl?: string;
  },
  config: ResolvedConfig,
): Record<string, any> {
  const body: Record<string, any> = {
    query: params.query,
    type: params.type ?? "auto",
    numResults: params.numResults ?? config.defaults.searchNumResults,
  };

  if (params.category) body.category = params.category;
  if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
  if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
  if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
  if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;
  if (typeof params.maxAgeHours === "number") body.maxAgeHours = params.maxAgeHours;
  if (params.livecrawl) body.livecrawl = params.livecrawl;

  const contents = buildSearchContents(params, config);
  if (Object.keys(contents).length > 0) body.contents = contents;

  return body;
}

function buildContentsBody(
  params: SearchContentsParams & {
    urls: string[];
    subpages?: number;
    subpageTarget?: string;
    maxAgeHours?: number;
    livecrawlTimeout?: number;
  },
  config: ResolvedConfig,
): Record<string, any> {
  const body: Record<string, any> = {
    ids: params.urls,
  };

  const contents = buildSearchContents(params, config);
  if (contents.text) body.text = contents.text;
  if (contents.highlights) body.highlights = contents.highlights;
  if (contents.summary) body.summary = contents.summary;
  if (typeof params.subpages === "number") body.subpages = params.subpages;
  if (params.subpageTarget) body.subpageTarget = params.subpageTarget;
  if (typeof params.maxAgeHours === "number") body.maxAgeHours = params.maxAgeHours;
  if (typeof params.livecrawlTimeout === "number") body.livecrawlTimeout = params.livecrawlTimeout;

  return body;
}

function buildCompanyResearchBody(
  params: SearchContentsParams & {
    query: string;
    mode?: string;
    type?: string;
    numResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    startPublishedDate?: string;
    endPublishedDate?: string;
    livecrawl?: string;
    maxAgeHours?: number;
  },
  config: ResolvedConfig,
): { body: Record<string, any>; notes: string[] } {
  const mode = params.mode ?? "company";
  const body = buildSearchBody(
    {
      ...params,
      category: mode === "general" ? undefined : mode,
      type: params.type ?? (mode === "general" ? "deep" : "auto"),
      numResults: params.numResults ?? config.defaults.searchNumResults,
    },
    config,
  );

  const notes: string[] = [];
  if (mode === "company") {
    const dropped: string[] = [];
    if (body.includeDomains) {
      delete body.includeDomains;
      dropped.push("includeDomains");
    }
    if (body.excludeDomains) {
      delete body.excludeDomains;
      dropped.push("excludeDomains");
    }
    if (body.startPublishedDate) {
      delete body.startPublishedDate;
      dropped.push("startPublishedDate");
    }
    if (body.endPublishedDate) {
      delete body.endPublishedDate;
      dropped.push("endPublishedDate");
    }
    if (dropped.length > 0) {
      notes.push(`Dropped ${dropped.join(", ")} because Exa company-category search rejects those filters.`);
    }
  }

  return { body, notes };
}

function statusText(config: ResolvedConfig): string {
  const enabled = Object.entries(config.tools)
    .filter(([, value]) => value)
    .map(([key]) => TOOL_LABELS[key as ToolToggleName])
    .join(", ");
  const keyState = config.authMode === "none" ? "auth disabled" : config.apiKey ? "key ready" : `missing ${config.apiKeyEnv}`;
  return `Exa ${keyState} @ ${config.baseUrl} [${enabled || "no tools"}]`;
}

function configSummaryLines(config: ResolvedConfig): string[] {
  const enabledTools = Object.entries(config.tools)
    .filter(([, value]) => value)
    .map(([key]) => TOOL_LABELS[key as ToolToggleName]);

  return [
    `baseUrl: ${config.baseUrl}`,
    `authMode: ${config.authMode}`,
    `apiKeyEnv: ${config.apiKeyEnv}`,
    `savedKey: ${maskApiKey(config.apiKey)}`,
    `userConfig: ${config.userConfigPath}`,
    `timeoutMs: ${config.timeoutMs}`,
    `enabledTools: ${enabledTools.length > 0 ? enabledTools.join(", ") : "(none)"}`,
  ];
}

function updateStatusFromConfig(ctx: { ui: { setStatus: (id: string, text?: string) => void } }) {
  // Keep Exa feedback in explicit commands instead of a persistent footer badge.
  ctx.ui.setStatus("exa", undefined);
}

const searchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  type: Type.Optional(StringEnum(SEARCH_TYPES, { description: "Search strategy" })),
  category: Type.Optional(StringEnum(SEARCH_CATEGORIES, { description: "Optional content category" })),
  numResults: Type.Optional(Type.Number({ description: "Maximum results to return" })),
  livecrawl: Type.Optional(StringEnum(LIVECRAWL_MODES, { description: "Live crawl mode" })),
  maxAgeHours: Type.Optional(Type.Number({ description: "Maximum cache age in hours" })),
  includeDomains: Type.Optional(Type.Array(Type.String({ description: "Restrict results to these domains" }))),
  excludeDomains: Type.Optional(Type.Array(Type.String({ description: "Exclude results from these domains" }))),
  startPublishedDate: Type.Optional(Type.String({ description: "ISO date lower bound" })),
  endPublishedDate: Type.Optional(Type.String({ description: "ISO date upper bound" })),
  includeText: Type.Optional(Type.Boolean({ description: "Include extracted page text" })),
  textMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for page text" })),
  includeHighlights: Type.Optional(Type.Boolean({ description: "Include highlights" })),
  highlightQuery: Type.Optional(Type.String({ description: "Focus query for highlights" })),
  highlightMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for highlights" })),
  includeSummary: Type.Optional(Type.Boolean({ description: "Include Exa summaries" })),
  summaryQuery: Type.Optional(Type.String({ description: "Focus query for summaries" })),
});

const answerSchema = Type.Object({
  query: Type.String({ description: "Question to answer with Exa" }),
  includeText: Type.Optional(Type.Boolean({ description: "Ask Exa to return supporting text" })),
});

const contentsSchema = Type.Object({
  urls: Type.Array(Type.String({ description: "URL to fetch content for" })),
  includeText: Type.Optional(Type.Boolean({ description: "Include extracted page text" })),
  textMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for page text" })),
  includeHtmlTags: Type.Optional(Type.Boolean({ description: "Keep HTML tags in text output" })),
  includeHighlights: Type.Optional(Type.Boolean({ description: "Include highlights" })),
  highlightQuery: Type.Optional(Type.String({ description: "Focus query for highlights" })),
  highlightMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for highlights" })),
  includeSummary: Type.Optional(Type.Boolean({ description: "Include summary" })),
  summaryQuery: Type.Optional(Type.String({ description: "Focus query for summary" })),
  subpages: Type.Optional(Type.Number({ description: "Number of subpages to crawl" })),
  subpageTarget: Type.Optional(Type.String({ description: "Keyword to prioritize for subpages" })),
  maxAgeHours: Type.Optional(Type.Number({ description: "Maximum cache age in hours" })),
  livecrawlTimeout: Type.Optional(Type.Number({ description: "Live crawl timeout in milliseconds" })),
});

const codeContextSchema = Type.Object({
  query: Type.String({ description: "Natural language query for code examples and API usage" }),
  tokensNum: Type.Optional(Type.Number({ description: "Exact token budget for returned code context" })),
  dynamicTokens: Type.Optional(Type.Boolean({ description: "Use Exa dynamic token sizing" })),
});

const companyResearchSchema = Type.Object({
  query: Type.String({ description: "Company or market research query" }),
  mode: Type.Optional(StringEnum(COMPANY_RESEARCH_MODES, { description: "Research mode" })),
  type: Type.Optional(StringEnum(SEARCH_TYPES, { description: "Search strategy" })),
  numResults: Type.Optional(Type.Number({ description: "Maximum results to return" })),
  livecrawl: Type.Optional(StringEnum(LIVECRAWL_MODES, { description: "Live crawl mode" })),
  maxAgeHours: Type.Optional(Type.Number({ description: "Maximum cache age in hours" })),
  includeDomains: Type.Optional(Type.Array(Type.String({ description: "Restrict results to these domains" }))),
  excludeDomains: Type.Optional(Type.Array(Type.String({ description: "Exclude results from these domains" }))),
  startPublishedDate: Type.Optional(Type.String({ description: "ISO date lower bound" })),
  endPublishedDate: Type.Optional(Type.String({ description: "ISO date upper bound" })),
  includeText: Type.Optional(Type.Boolean({ description: "Include extracted page text" })),
  textMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for page text" })),
  includeHighlights: Type.Optional(Type.Boolean({ description: "Include highlights" })),
  highlightQuery: Type.Optional(Type.String({ description: "Focus query for highlights" })),
  highlightMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for highlights" })),
  includeSummary: Type.Optional(Type.Boolean({ description: "Include Exa summaries" })),
  summaryQuery: Type.Optional(Type.String({ description: "Focus query for summaries" })),
});

const linkedinSearchSchema = Type.Object({
  query: Type.String({ description: "Person or role query for public LinkedIn-style results" }),
  numResults: Type.Optional(Type.Number({ description: "Maximum people results to return" })),
  includeHighlights: Type.Optional(Type.Boolean({ description: "Include highlights" })),
  highlightQuery: Type.Optional(Type.String({ description: "Focus query for highlights" })),
  highlightMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for highlights" })),
  includeText: Type.Optional(Type.Boolean({ description: "Include extracted profile text" })),
  textMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for extracted text" })),
});

const crawlSchema = Type.Object({
  urls: Type.Array(Type.String({ description: "Starting URLs to crawl" })),
  subpages: Type.Optional(Type.Number({ description: "How many subpages to crawl from each URL" })),
  subpageTarget: Type.Optional(Type.String({ description: "Keyword to prioritize for subpage crawling" })),
  includeText: Type.Optional(Type.Boolean({ description: "Include extracted page text" })),
  textMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for page text" })),
  includeHighlights: Type.Optional(Type.Boolean({ description: "Include highlights" })),
  highlightQuery: Type.Optional(Type.String({ description: "Focus query for highlights" })),
  highlightMaxCharacters: Type.Optional(Type.Number({ description: "Max characters for highlights" })),
  includeSummary: Type.Optional(Type.Boolean({ description: "Include summaries" })),
  summaryQuery: Type.Optional(Type.String({ description: "Focus query for summaries" })),
  maxAgeHours: Type.Optional(Type.Number({ description: "Maximum cache age in hours" })),
  livecrawlTimeout: Type.Optional(Type.Number({ description: "Live crawl timeout in milliseconds" })),
});

const deepResearchStartSchema = Type.Object({
  query: Type.String({ description: "Research question to investigate deeply" }),
  type: Type.Optional(StringEnum(["deep", "deep-reasoning"] as const, { description: "Deep research mode" })),
  numResults: Type.Optional(Type.Number({ description: "How many source pages Exa should inspect" })),
  includeText: Type.Optional(Type.Boolean({ description: "Include full text while Exa researches" })),
  textMaxCharacters: Type.Optional(Type.Number({ description: "Max characters of source text to pull" })),
  outputSchemaJson: Type.Optional(Type.String({ description: "Optional JSON schema string for structured output" })),
});

const deepResearchCheckSchema = Type.Object({
  jobId: Type.String({ description: "Job id returned by exa-deep-research-start" }),
});

const EXA_SYSTEM_PROMPT = `## Exa

Exa tools are installed. Use them for live web research when the task benefits from result discovery, extraction controls, or cited synthesis.

Choose tools as follows:
- Use exa-search for broad web research that benefits from domain filters, date filters, highlights, summaries, or livecrawl.
- Use exa-answer when the user wants a synthesized answer grounded in live web results with citations.
- Use exa-contents when the user already has one or more URLs and wants clean extraction, highlights, or summaries.
- Use exa-code-context when the user needs public code examples, setup patterns, or API usage from the wider web.
- Use exa-company-research for company, competitor, market, news, and public-profile research.
- Use exa-linkedin-search for public people or role discovery by title, company, or expertise.
- Use exa-crawl when the user wants a site and related subpages explored from seed URLs.
- Use exa-deep-research-start and exa-deep-research-check for longer research tasks that should run asynchronously.
- Do not use Exa for GitHub repository content; use GitHub-native tools or general page fetch tools instead.`;

export default function exaExtension(pi: ExtensionAPI) {
  hydrateJobs();

  pi.on("session_start", async (_event, ctx) => {
    updateStatusFromConfig(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${EXA_SYSTEM_PROMPT}`,
    };
  });

  pi.registerCommand("exa-status", {
    description: "Show the current Exa extension configuration status",
    handler: async (_args, ctx) => {
      try {
        const config = loadConfig();
        const message = `${statusText(config)} key=${maskApiKey(config.apiKey)}`;
        ctx.ui.notify(message, config.apiKey || config.authMode === "none" ? "success" : "warning");
      } catch (error) {
        ctx.ui.notify(`Exa config error: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("exa-auth", {
    description: "Save or clear the Exa API key in the user-level Exa config",
    handler: async (args, ctx) => {
      try {
        const trimmedArgs = args.trim();
        if (trimmedArgs === "--clear") {
          const fileConfig = readConfigFile();
          delete fileConfig.apiKey;
          writeConfigFile(fileConfig);
          updateStatusFromConfig(ctx);
          ctx.ui.notify(`Cleared saved Exa API key from ${getConfigPaths().writeConfigPath}`, "info");
          return;
        }

        const providedKey = trimmedArgs || (await ctx.ui.input("Exa API key:", ""))?.trim() || "";
        if (!providedKey) {
          ctx.ui.notify("No API key provided", "warning");
          return;
        }

        const fileConfig = readConfigFile();
        fileConfig.apiKey = providedKey;
        fileConfig.authMode = fileConfig.authMode ?? "x-api-key";
        writeConfigFile(fileConfig);

        const config = loadConfig();
        updateStatusFromConfig(ctx);
        ctx.ui.notify(`Saved Exa API key to ${getConfigPaths().writeConfigPath} (${maskApiKey(config.apiKey)})`, "success");
      } catch (error) {
        ctx.ui.notify(`Exa auth error: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("exa-tools", {
    description: "Show the Exa tools currently exposed to the model",
    handler: async (_args, ctx) => {
      try {
        const config = loadConfig();
        const enabled = Object.entries(config.tools)
          .filter(([, value]) => value)
          .map(([key]) => TOOL_LABELS[key as ToolToggleName]);
        ctx.ui.notify(`Enabled Exa tools:\n${enabled.map((tool) => `- ${tool}`).join("\n")}`, "info");
      } catch (error) {
        ctx.ui.notify(`Exa tools error: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("exa-config", {
    description: "Interactively edit Exa endpoint, auth mode, key env, and tool toggles",
    handler: async (_args, ctx) => {
      try {
        while (true) {
          const config = loadConfig();
          const choice = await ctx.ui.select(
            `Exa config\n\n${configSummaryLines(config).join("\n")}\n\nChoose what to edit:`,
            [
              "Set baseUrl",
              "Set authMode",
              "Set apiKeyEnv",
              "Toggle tools",
              "Set timeoutMs",
              "Reset to defaults",
              "Done",
            ],
          );

          if (!choice || choice === "Done") return;

          const fileConfig = readConfigFile();

          if (choice === "Set baseUrl") {
            const nextValue = (await ctx.ui.input("Exa baseUrl:", config.baseUrl))?.trim();
            if (!nextValue) {
              ctx.ui.notify("Base URL unchanged", "info");
              continue;
            }
            fileConfig.baseUrl = nextValue.replace(/\/+$/, "");
            writeConfigFile(fileConfig);
            updateStatusFromConfig(ctx);
            ctx.ui.notify(`Set Exa baseUrl to ${fileConfig.baseUrl}`, "success");
            continue;
          }

          if (choice === "Set authMode") {
            const authMode = await ctx.ui.select("Pick Exa auth mode:", ["x-api-key", "bearer", "none"]);
            if (!authMode) continue;
            fileConfig.authMode = authMode as AuthMode;
            writeConfigFile(fileConfig);
            updateStatusFromConfig(ctx);
            ctx.ui.notify(`Set Exa auth mode to ${authMode}`, "success");
            continue;
          }

          if (choice === "Set apiKeyEnv") {
            const nextValue = (await ctx.ui.input("Environment variable name for the key:", config.apiKeyEnv))?.trim();
            if (!nextValue) {
              ctx.ui.notify("apiKeyEnv unchanged", "info");
              continue;
            }
            fileConfig.apiKeyEnv = nextValue;
            writeConfigFile(fileConfig);
            updateStatusFromConfig(ctx);
            ctx.ui.notify(`Set Exa apiKeyEnv to ${nextValue}`, "success");
            continue;
          }

          if (choice === "Set timeoutMs") {
            const nextValue = (await ctx.ui.input("Timeout in milliseconds:", String(config.timeoutMs)))?.trim();
            if (!nextValue) {
              ctx.ui.notify("timeoutMs unchanged", "info");
              continue;
            }
            const parsed = Number(nextValue);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              ctx.ui.notify("timeoutMs must be a positive number", "error");
              continue;
            }
            fileConfig.timeoutMs = parsed;
            writeConfigFile(fileConfig);
            updateStatusFromConfig(ctx);
            ctx.ui.notify(`Set Exa timeoutMs to ${parsed}`, "success");
            continue;
          }

          if (choice === "Toggle tools") {
            const toolChoices = Object.entries(TOOL_LABELS).map(([key, label]) => ({
              key: key as ToolToggleName,
              label,
              enabled: config.tools[key as ToolToggleName],
            }));
            const picked = await ctx.ui.select(
              "Pick an Exa tool to toggle:",
              [
                ...toolChoices.map((tool) => `${tool.enabled ? "disable" : "enable"} ${tool.label}`),
                "Enable all",
                "Disable all",
                "Back",
              ],
            );
            if (!picked || picked === "Back") continue;

            fileConfig.tools = { ...(fileConfig.tools ?? {}) };
            if (picked === "Enable all") {
              for (const tool of toolChoices) fileConfig.tools[tool.key] = true;
              writeConfigFile(fileConfig);
              updateStatusFromConfig(ctx);
              ctx.ui.notify("Enabled all Exa tools", "success");
              continue;
            }
            if (picked === "Disable all") {
              for (const tool of toolChoices) fileConfig.tools[tool.key] = false;
              writeConfigFile(fileConfig);
              updateStatusFromConfig(ctx);
              ctx.ui.notify("Disabled all Exa tools", "warning");
              continue;
            }

            const selectedTool = toolChoices.find((tool) => picked.endsWith(tool.label));
            if (!selectedTool) continue;
            fileConfig.tools[selectedTool.key] = !selectedTool.enabled;
            writeConfigFile(fileConfig);
            updateStatusFromConfig(ctx);
            ctx.ui.notify(
              `${fileConfig.tools[selectedTool.key] ? "Enabled" : "Disabled"} ${selectedTool.label}`,
              fileConfig.tools[selectedTool.key] ? "success" : "warning",
            );
            continue;
          }

          if (choice === "Reset to defaults") {
            const confirmed = await ctx.ui.confirm(
              "Reset Exa config?",
              `This will rewrite ${getConfigPaths().writeConfigPath} with the default endpoint, auth mode, and tool toggles.`,
            );
            if (!confirmed) continue;
            writeConfigFile({
              baseUrl: DEFAULT_CONFIG.baseUrl,
              apiKeyEnv: DEFAULT_CONFIG.apiKeyEnv,
              authMode: DEFAULT_CONFIG.authMode,
              timeoutMs: DEFAULT_CONFIG.timeoutMs,
              tools: { ...DEFAULT_CONFIG.tools },
              defaults: { ...DEFAULT_CONFIG.defaults },
            });
            updateStatusFromConfig(ctx);
            ctx.ui.notify("Reset Exa config to defaults", "success");
          }
        }
      } catch (error) {
        ctx.ui.notify(`Exa config editor error: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("exa-jobs", {
    description: "Show recent Exa deep research jobs",
    handler: async (args, ctx) => {
      const requestedLimit = Number(args.trim() || "8");
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(50, Math.floor(requestedLimit)) : 8;
      const jobs = listJobs(limit);
      if (jobs.length === 0) {
        ctx.ui.notify("No Exa deep research jobs yet", "info");
        return;
      }

      ctx.ui.notify(`Recent Exa jobs:\n${jobs.map((job) => formatJobLine(job)).join("\n")}`, "info");
    },
  });

  pi.registerCommand("exa-job-show", {
    description: "Show full details for one Exa deep research job",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        ctx.ui.notify("Usage: /exa-job-show <jobId>", "error");
        return;
      }

      const job = getJob(jobId);
      if (!job) {
        ctx.ui.notify(`Unknown Exa job: ${jobId}`, "error");
        return;
      }

      ctx.ui.notify(formatJobDetails(job), job.status === "error" ? "warning" : "info");
    },
  });

  pi.registerCommand("exa-job-delete", {
    description: "Delete one Exa deep research job from the local job store",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        ctx.ui.notify("Usage: /exa-job-delete <jobId>", "error");
        return;
      }

      const job = getJob(jobId);
      if (!job) {
        ctx.ui.notify(`Unknown Exa job: ${jobId}`, "error");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Delete Exa job?",
        `Remove ${job.id} (${job.status}) from the local Exa job store?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      removeJob(jobId);
      ctx.ui.notify(`Deleted Exa job ${jobId}`, "success");
    },
  });

  pi.registerCommand("exa-job-prune", {
    description: "Delete completed and failed Exa deep research jobs, keeping running ones",
    handler: async (args, ctx) => {
      const mode = args.trim();
      const removed = pruneJobs((job) => {
        if (mode === "--errors") return job.status === "error";
        if (mode === "--completed") return job.status === "completed";
        return job.status !== "running";
      });
      ctx.ui.notify(
        removed > 0
          ? `Pruned ${removed} Exa jobs${mode ? ` (${mode})` : ""}`
          : `No Exa jobs matched prune filter${mode ? ` (${mode})` : ""}`,
        removed > 0 ? "success" : "info",
      );
    },
  });

  pi.registerCommand("exa-job-clear", {
    description: "Delete all local Exa deep research jobs",
    handler: async (_args, ctx) => {
      const jobs = listJobs(1000000);
      if (jobs.length === 0) {
        ctx.ui.notify("No Exa jobs to clear", "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Clear all Exa jobs?",
        `Delete all ${jobs.length} local Exa deep research jobs?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const removed = clearJobs();
      ctx.ui.notify(`Cleared ${removed} Exa jobs`, "success");
    },
  });

  // ── manual command wrappers for tools ──────────────────────────────────

  pi.registerCommand("exa-search", {
    description: "Search the web with Exa. Usage: /exa-search <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /exa-search <query>", "warning");
        return;
      }
      try {
        const config = loadConfig();
        const response = await postJson(config, "/search", buildSearchBody({ query, numResults: config.defaults.searchNumResults }, config));
        const text = finalizeOutput(formatSearchResponse(response));
        pi.sendMessage({ customType: "exa-search-result", content: text, display: true, details: { query } });
      } catch (error) {
        ctx.ui.notify(`Exa search failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("exa-answer", {
    description: "Get an Exa-synthesized answer. Usage: /exa-answer <question>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /exa-answer <question>", "warning");
        return;
      }
      try {
        const config = loadConfig();
        const response = await postJson(config, "/answer", { query, text: false });
        const text = finalizeOutput(formatAnswerResponse(response));
        pi.sendMessage({ customType: "exa-answer-result", content: text, display: true, details: { query } });
      } catch (error) {
        ctx.ui.notify(`Exa answer failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("exa-code-context", {
    description: "Fetch code examples from Exa. Usage: /exa-code-context <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /exa-code-context <query>", "warning");
        return;
      }
      try {
        const config = loadConfig();
        const tokensNum = config.defaults.codeContextTokens === "dynamic" ? 5000 : config.defaults.codeContextTokens;
        const response = await postJson(config, "/context", { query, tokensNum });
        const text = finalizeOutput(formatCodeContextResponse(response));
        pi.sendMessage({ customType: "exa-code-context-result", content: text, display: true, details: { query } });
      } catch (error) {
        ctx.ui.notify(`Exa code context failed: ${(error as Error).message}`, "error");
      }
    },
  });

  // ── tools ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "exa-search",
    label: "Exa Search",
    description: "Search the web with Exa. Supports categories, domain filters, livecrawl options, and optional extracted text, highlights, and summaries.",
    promptSnippet: "Search the web with Exa when the user wants current sources, citations, or focused domain search.",
    promptGuidelines: [
      "NEVER use Exa for GitHub content (issues, PRs, files, repos). Use `gh` CLI or web-fetch instead — they are free, faster, and return structured data.",
      "Use exa-search for web research, current events, and source gathering when the task benefits from domain filters, recency filters, highlights, summaries, or livecrawl.",
      "Use exa-search when the user needs result discovery across the web rather than extraction from a single known page.",
      "Prefer includeHighlights before includeText when you need a concise answer with citations.",
    ],
    parameters: searchSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const config = loadConfig();
      assertToolEnabled(config, "search");
      onUpdate?.({ content: [{ type: "text", text: "Querying Exa search..." }] });
      const response = await postJson(config, "/search", buildSearchBody(params, config), signal);
      const resultCount = Array.isArray(response?.results) ? response.results.length : 0;
      return {
        content: [{ type: "text", text: finalizeOutput(formatSearchResponse(response)) }],
        details: { endpoint: "/search", resultCount },
      };
    },
  });

  pi.registerTool({
    name: "exa-answer",
    label: "Exa Answer",
    description: "Ask Exa for a synthesized answer grounded in live web search results.",
    promptSnippet: "Get a grounded answer with citations from Exa when the user asks a factual web question.",
    promptGuidelines: [
      "NEVER use Exa for GitHub content (issues, PRs, files, repos). Use `gh` CLI or web-fetch instead.",
      "Use exa-answer when the user wants a direct answer backed by live web citations rather than a raw result list.",
      "Use exa-answer when synthesis is more useful than inspecting individual search results.",
    ],
    parameters: answerSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const config = loadConfig();
      assertToolEnabled(config, "answer");
      onUpdate?.({ content: [{ type: "text", text: "Querying Exa answer..." }] });
      const response = await postJson(
        config,
        "/answer",
        {
          query: params.query,
          text: params.includeText ?? false,
        },
        signal,
      );
      const citationCount = Array.isArray(response?.citations)
        ? response.citations.length
        : Array.isArray(response?.sources)
          ? response.sources.length
          : Array.isArray(response?.results)
            ? response.results.length
            : 0;
      return {
        content: [{ type: "text", text: finalizeOutput(formatAnswerResponse(response)) }],
        details: { endpoint: "/answer", citationCount },
      };
    },
  });

  pi.registerTool({
    name: "exa-contents",
    label: "Exa Contents",
    description: "Fetch clean page contents, highlights, and summaries for specific URLs using Exa.",
    promptSnippet: "Fetch clean content from URLs with Exa when the user provides specific pages to read.",
    promptGuidelines: [
      "NEVER use Exa for GitHub content (issues, PRs, files, repos). Use `gh` CLI or web-fetch instead.",
      "Use exa-contents when the user already has one or more URLs and wants clean extraction, highlights, or summaries.",
      "Use exa-contents after exa-search when a small set of result pages needs closer reading.",
    ],
    parameters: contentsSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const config = loadConfig();
      assertToolEnabled(config, "contents");
      onUpdate?.({ content: [{ type: "text", text: "Fetching Exa contents..." }] });
      const response = await postJson(config, "/contents", buildContentsBody(params, config), signal);
      const itemCount = Array.isArray(response?.results)
        ? response.results.length
        : Array.isArray(response?.contents)
          ? response.contents.length
          : Array.isArray(response?.data)
            ? response.data.length
            : 0;
      return {
        content: [{ type: "text", text: finalizeOutput(formatContentsResponse(response)) }],
        details: { endpoint: "/contents", itemCount },
      };
    },
  });

  pi.registerTool({
    name: "exa-code-context",
    label: "Exa Code Context",
    description: "Search Exa's code context index for framework usage, API syntax, and code examples.",
    promptSnippet: "Get code examples and API usage from Exa when the user asks for implementation context from the web.",
    promptGuidelines: [
      "NEVER use Exa for GitHub content (issues, PRs, files, repos). Use `gh` CLI or web-fetch instead.",
      "Use exa-code-context for framework examples, library setup, and API syntax when source code examples matter more than prose pages.",
      "Prefer Context7 first for official library docs, then use exa-code-context when broader public examples are useful.",
    ],
    parameters: codeContextSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const config = loadConfig();
      assertToolEnabled(config, "codeContext");
      onUpdate?.({ content: [{ type: "text", text: "Fetching Exa code context..." }] });
      const tokensNum = params.dynamicTokens || params.tokensNum == null ? config.defaults.codeContextTokens : params.tokensNum;
      const response = await postJson(
        config,
        "/context",
        {
          query: params.query,
          tokensNum,
        },
        signal,
      );
      return {
        content: [{ type: "text", text: finalizeOutput(formatCodeContextResponse(response)) }],
        details: { endpoint: "/context", resultsCount: response?.resultsCount },
      };
    },
  });

  pi.registerTool({
    name: "exa-company-research",
    label: "Exa Company Research",
    description: "Run company-oriented research over Exa with tuned modes for company discovery, news, social, people, and general deep dives.",
    promptSnippet: "Research companies, competitors, market news, or public company-related people with Exa.",
    promptGuidelines: [
      "Use exa-company-research when the task is about companies, competitors, markets, news, or company-related public profiles.",
      "Use exa-company-research instead of generic exa-search when the request is primarily company-oriented.",
    ],
    parameters: companyResearchSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const config = loadConfig();
      assertToolEnabled(config, "companyResearch");
      onUpdate?.({ content: [{ type: "text", text: "Running Exa company research..." }] });
      const { body, notes } = buildCompanyResearchBody(params, config);
      const response = await postJson(config, "/search", body, signal);
      return {
        content: [{ type: "text", text: finalizeOutput(formatSearchResponse(response, notes)) }],
        details: { endpoint: "/search", mode: params.mode ?? "company" },
      };
    },
  });

  pi.registerTool({
    name: "exa-linkedin-search",
    label: "Exa LinkedIn Search",
    description: "Search public people/profile results through Exa's people category, useful for LinkedIn-style discovery.",
    promptSnippet: "Find public people or role/profile results with Exa when the user wants LinkedIn-style search.",
    promptGuidelines: [
      "Use exa-linkedin-search for public people or profile discovery when the user asks for roles, titles, likely profile pages, or candidate lists.",
      "Use exa-linkedin-search instead of broad web search when person discovery is the main task.",
    ],
    parameters: linkedinSearchSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const config = loadConfig();
      assertToolEnabled(config, "linkedinSearch");
      onUpdate?.({ content: [{ type: "text", text: "Running Exa LinkedIn-style people search..." }] });
      const response = await postJson(
        config,
        "/search",
        buildSearchBody(
          {
            ...params,
            category: "people",
            type: "auto",
            numResults: params.numResults ?? config.defaults.searchNumResults,
          },
          config,
        ),
        signal,
      );
      return {
        content: [{ type: "text", text: finalizeOutput(formatSearchResponse(response)) }],
        details: { endpoint: "/search", category: "people" },
      };
    },
  });

  pi.registerTool({
    name: "exa-crawl",
    label: "Exa Crawl",
    description: "Crawl starting URLs and their subpages through Exa contents extraction, optionally focusing on specific targets.",
    promptSnippet: "Crawl sites and subpages with Exa when the user wants broader extraction than a single page read.",
    promptGuidelines: [
      "NEVER use Exa for GitHub content (issues, PRs, files, repos). Use `gh` CLI or web-fetch instead.",
      "Use exa-crawl when the user wants multi-page extraction from a site starting from one or more seed URLs.",
      "Use exa-crawl to expand from a homepage or landing page into related subpages such as docs, pricing, references, or support pages.",
    ],
    parameters: crawlSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const config = loadConfig();
      assertToolEnabled(config, "crawling");
      onUpdate?.({ content: [{ type: "text", text: "Running Exa crawl..." }] });
      const response = await postJson(config, "/contents", buildContentsBody(params, config), signal);
      return {
        content: [{ type: "text", text: finalizeOutput(formatContentsResponse(response)) }],
        details: { endpoint: "/contents", urls: params.urls.length },
      };
    },
  });

  pi.registerTool({
    name: "exa-deep-research-start",
    label: "Exa Deep Research Start",
    description: "Start a deep Exa research job and get back a local job id for later polling.",
    promptSnippet: "Start a deep Exa research job when the task may take longer and you want to poll later.",
    promptGuidelines: [
      "Use exa-deep-research-start for longer research tasks that should continue asynchronously.",
      "Follow exa-deep-research-start with exa-deep-research-check until the job completes.",
    ],
    parameters: deepResearchStartSchema,
    async execute(_toolCallId, params, _signal, onUpdate) {
      const config = loadConfig();
      assertToolEnabled(config, "deepResearchStart");
      hydrateJobs();

      const jobId = randomUUID();
      const createdAt = new Date().toISOString();
      const numResults = params.numResults ?? config.defaults.deepResearchNumResults;
      const mode = params.type ?? "deep";

      upsertJob({
        id: jobId,
        query: params.query,
        mode,
        numResults,
        status: "running",
        createdAt,
        updatedAt: createdAt,
      });

      onUpdate?.({ content: [{ type: "text", text: `Starting Exa deep research job ${jobId}...` }] });

      void (async () => {
        try {
          const body: Record<string, unknown> = {
            query: params.query,
            type: mode,
            numResults,
          };

          const contents = buildSearchContents(
            {
              includeText: params.includeText,
              textMaxCharacters: params.textMaxCharacters,
            },
            config,
          );
          if (Object.keys(contents).length > 0) body.contents = contents;

          if (params.outputSchemaJson) {
            body.outputSchema = JSON.parse(params.outputSchemaJson);
          }

          const response = await postJson(config, "/search", body);
          upsertJob({
            id: jobId,
            query: params.query,
            mode,
            numResults,
            status: "completed",
            createdAt,
            updatedAt: new Date().toISOString(),
            resultText: finalizeOutput(formatDeepResearchResponse(response)),
          });
        } catch (error) {
          upsertJob({
            id: jobId,
            query: params.query,
            mode,
            numResults,
            status: "error",
            createdAt,
            updatedAt: new Date().toISOString(),
            error: (error as Error).message,
          });
        }
      })();

      return {
        content: [
          {
            type: "text",
            text: `Started Exa deep research job ${jobId}. Use exa-deep-research-check with this jobId to poll for completion.`,
          },
        ],
        details: { jobId, status: "running", endpoint: "/search" },
      };
    },
  });

  pi.registerTool({
    name: "exa-deep-research-check",
    label: "Exa Deep Research Check",
    description: "Check the status of a deep Exa research job started earlier.",
    promptSnippet: "Poll an Exa deep research job started earlier and fetch the result when ready.",
    promptGuidelines: [
      "Use exa-deep-research-check after exa-deep-research-start; if status is running, wait and try again later.",
    ],
    parameters: deepResearchCheckSchema,
    async execute(_toolCallId, params) {
      const config = loadConfig();
      assertToolEnabled(config, "deepResearchCheck");
      hydrateJobs();

      const job = deepResearchJobs.get(params.jobId);
      if (!job) {
        throw new Error(`Unknown Exa deep research job: ${params.jobId}`);
      }

      if (job.status === "running") {
        return {
          content: [{ type: "text", text: `Job ${job.id} is still running for query: ${job.query}` }],
          details: { jobId: job.id, status: job.status },
        };
      }

      if (job.status === "error") {
        throw new Error(`Job ${job.id} failed: ${job.error}`);
      }

      return {
        content: [{ type: "text", text: `Job ${job.id} completed.\n\n${job.resultText || "No result text stored."}` }],
        details: { jobId: job.id, status: job.status },
      };
    },
  });
}
