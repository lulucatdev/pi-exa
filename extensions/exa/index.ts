/**
 * pi-exa — Exa web-research tools + API key manager.
 *
 * Architecture (v0.4.x):
 *   - Five registerTool entries: exa_search, exa_similar, exa_fetch,
 *     exa_answer, exa_research.
 *     Each calls the local Node CLI (skills/pi-exa/scripts/exa.mjs) via
 *     pi.exec, reads the markdown output, returns it as tool result text.
 *   - A prompt template (prompts/exa.md) binds the /exa command.
 *     When the user types /exa, the template loads and instructs the
 *     agent to call the appropriate tool directly — no skill body
 *     guessing, no bash CLI invocation by the model.
 *   - The skill (skills/pi-exa/SKILL.md) stays as a fallback for natural-
 *     language triggers. It teaches the model to use the CLI via bash
 *     when the user doesn't invoke /exa.
 *   - Two slash commands for key management: /exa-auth and /exa-status.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../skills/pi-exa/scripts/exa.mjs");

// ─── audit hook (silent; controlled by env var; agent never sees this) ─

function auditNativeCall(tool: string, params: unknown): void {
	const logPath = process.env.PI_EXA_AUDIT_LOG;
	if (!logPath) return;
	try {
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			run_id: process.env.PI_EXA_AUDIT_RUN_ID ?? "",
			pid: process.pid,
			source: "native",
			tool,
			params,
		});
		appendFileSync(logPath, line + "\n");
	} catch {
		// never let audit failure break the tool
	}
}

const HOME_DIR = process.env.HOME ?? process.cwd();
const KEY_PATH = path.join(HOME_DIR, ".pi", "exa.config.json");

// ─── key file helpers ─────────────────────────────────────────────────

type KeyFile = {
	apiKey?: string;
	[key: string]: unknown;
};

function readKeyFile(): KeyFile {
	if (!existsSync(KEY_PATH)) return {};
	try {
		return JSON.parse(readFileSync(KEY_PATH, "utf-8")) as KeyFile;
	} catch {
		return {};
	}
}

function writeKeyFile(file: KeyFile): void {
	mkdirSync(path.dirname(KEY_PATH), { recursive: true });
	writeFileSync(KEY_PATH, JSON.stringify(file, null, 2) + "\n", {
		encoding: "utf-8",
		mode: 0o600,
	});
}

function maskKey(key: string): string {
	if (!key) return "(missing)";
	if (key.length <= 8) return `${key.slice(0, 2)}***${key.slice(-1)}`;
	return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// ─── ANSI strip ─────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
	return text
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

// ─── run exa CLI helper ─────────────────────────────────────────────────

async function runExa(
	pi: ExtensionAPI,
	subcommand: string,
	cliArgs: string[],
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	// Inject an argv-level marker so the CLI's audit hook can label this call
	// as internal (triggered by a native tool), rather than a direct bash
	// invocation by the agent. argv-level avoids env-var races under
	// concurrent tool calls.
	const result = await pi.exec(
		process.execPath,
		[CLI_PATH, subcommand, "--_audit_internal", ...cliArgs],
		{
			signal: signal ?? new AbortController().signal,
			cwd,
		},
	);
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? 0,
	};
}

function formatExaError(stdout: string, stderr: string, code: number): string {
	const combined = stripAnsi(`${stderr}\n${stdout}`).trim();
	const lines = combined.split("\n").filter(Boolean);
	const firstError =
		lines.find((l) => l.match(/^EXA_[A-Z_]+:/)) ??
		lines[0] ??
		`(exited with code ${code})`;
	return firstError;
}

// ─── tool schemas ───────────────────────────────────────────────────────

const exaSearchSchema = Type.Object({
	query: Type.String({ description: "Search query." }),
	num: Type.Optional(
		Type.Number({ description: "Number of results (1-25, default 5)." }),
	),
	days: Type.Optional(
		Type.Number({ description: "Restrict to results published in the last N days." }),
	),
	from: Type.Optional(
		Type.String({ description: "Start published date (YYYY-MM-DD)." }),
	),
	to: Type.Optional(
		Type.String({ description: "End published date (YYYY-MM-DD)." }),
	),
	domain: Type.Optional(
		Type.Array(Type.String(), {
			description: "Include domains (repeatable).",
		}),
	),
	exclude: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exclude domains (repeatable).",
		}),
	),
	category: Type.Optional(
		Type.String({
			description:
				"Category filter: news, research paper, company, pdf, personal site, tweet, github.",
		}),
	),
	type: Type.Optional(
		Type.String({
			description:
				"Search type: auto, neural, keyword, hybrid, deep-lite, deep, deep-reasoning. Default auto.",
		}),
	),
	full: Type.Optional(
		Type.Boolean({
			description: "Return full text (~5000 chars) instead of highlights.",
		}),
	),
	maxChars: Type.Optional(
		Type.Number({
			description: "Override max characters per result when full=true.",
		}),
	),
	systemPrompt: Type.Optional(
		Type.String({
			description: "System prompt to guide the LLM when using deep search types (deep-lite, deep, deep-reasoning).",
		}),
	),
	outputSchema: Type.Optional(
		Type.String({
			description: "JSON schema string for structured deep-search output. Only works with deep search types.",
		}),
	),
});

const exaFetchSchema = Type.Object({
	urls: Type.Array(Type.String(), {
		description: "URLs to fetch content from.",
	}),
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("text"), Type.Literal("summary"), Type.Literal("highlights")],
			{
				description: 'Content mode: text (default), summary, or highlights.',
			},
		),
	),
	maxChars: Type.Optional(
		Type.Number({
			description: "Character budget per page for text mode (default 5000).",
		}),
	),
	livecrawl: Type.Optional(
		Type.Union(
			[
				Type.Literal("never"),
				Type.Literal("fallback"),
				Type.Literal("always"),
				Type.Literal("auto"),
				Type.Literal("preferred"),
			],
			{
				description: "Livecrawl mode: bypass Exa cache for real-time content. 'always' = always fetch fresh. 'fallback' = fetch fresh only if cached is stale. 'never' = use cache only. Default: auto.",
			},
		),
	),
	subpages: Type.Optional(
		Type.Number({
			description: "Number of subpages to extract per URL (0-10). Subpages are derived from internal links. Useful for getting about/team/blog pages from a site.",
		}),
	),
	subpageTarget: Type.Optional(
		Type.String({
			description: "Fuzzy text to match/rank subpages. E.g. 'about' to get about pages. Only used when subpages > 0.",
		}),
	),
});

const exaAnswerSchema = Type.Object({
	question: Type.String({ description: "Question to answer." }),
	location: Type.Optional(
		Type.String({
			description: "ISO country code for location-aware answers (e.g. US, JP).",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "Override answer model (default exa).",
		}),
	),
	systemPrompt: Type.Optional(
		Type.String({
			description: "System prompt to guide the answer style. E.g. 'Answer concisely for beginners' or 'Answer in Chinese'.",
		}),
	),
});

const exaSimilarSchema = Type.Object({
	url: Type.String({ description: "URL to find similar content for." }),
	num: Type.Optional(
		Type.Number({ description: "Number of similar results (1-25, default 5)." }),
	),
	excludeSource: Type.Optional(
		Type.Boolean({
			description: "Exclude the source URL's domain from results.",
		}),
	),
	full: Type.Optional(
		Type.Boolean({
			description: "Return full text (~5000 chars) instead of highlights.",
		}),
	),
	maxChars: Type.Optional(
		Type.Number({
			description: "Override max characters per result when full=true.",
		}),
	),
});

const exaResearchSchema = Type.Object({
	instructions: Type.String({
		description: "Research instructions. Be specific about what to find, how to conduct the research, and what the output should look like.",
	}),
	model: Type.Optional(
		Type.Union(
			[
				Type.Literal("exa-research-fast"),
				Type.Literal("exa-research"),
				Type.Literal("exa-research-pro"),
			],
			{
				description:
					"Research model: exa-research-fast (faster, cheaper), exa-research (default, balanced), exa-research-pro (thorough, stronger reasoning).",
			},
		),
	),
	maxWaitMs: Type.Optional(
		Type.Number({
			description:
				"Maximum time to wait for completion in milliseconds. Default 300000 (5 minutes).",
		}),
	),
	outputSchema: Type.Optional(
		Type.String({
			description: "JSON schema string for structured research output. Exa validates the output against this schema and returns parsed JSON.",
		}),
	),
});

type ExaSearchParams = Static<typeof exaSearchSchema>;
type ExaSimilarParams = Static<typeof exaSimilarSchema>;
type ExaFetchParams = Static<typeof exaFetchSchema>;
type ExaAnswerParams = Static<typeof exaAnswerSchema>;
type ExaResearchParams = Static<typeof exaResearchSchema>;

// ─── build CLI args helpers ─────────────────────────────────────────────

function buildSearchArgs(params: ExaSearchParams): string[] {
	const args: string[] = [params.query];
	if (params.num !== undefined) args.push("--num", String(params.num));
	if (params.days !== undefined) args.push("--days", String(params.days));
	if (params.from) args.push("--from", params.from);
	if (params.to) args.push("--to", params.to);
	if (params.domain) {
		for (const d of params.domain) args.push("--domain", d);
	}
	if (params.exclude) {
		for (const d of params.exclude) args.push("--exclude", d);
	}
	if (params.category) args.push("--category", params.category);
	if (params.type) args.push("--type", params.type);
	if (params.full) args.push("--full");
	if (params.maxChars !== undefined) args.push("--max-chars", String(params.maxChars));
	if (params.systemPrompt) args.push("--system-prompt", params.systemPrompt);
	if (params.outputSchema) args.push("--output-schema", params.outputSchema);
	return args;
}

function buildFetchArgs(params: ExaFetchParams): string[] {
	const args: string[] = [...params.urls];
	if (params.mode) args.push("--mode", params.mode);
	if (params.maxChars !== undefined) args.push("--max-chars", String(params.maxChars));
	if (params.livecrawl) args.push("--livecrawl", params.livecrawl);
	if (params.subpages !== undefined) args.push("--subpages", String(params.subpages));
	if (params.subpageTarget) args.push("--subpage-target", params.subpageTarget);
	return args;
}

function buildAnswerArgs(params: ExaAnswerParams): string[] {
	const args: string[] = [params.question];
	if (params.location) args.push("--location", params.location);
	if (params.model) args.push("--model", params.model);
	if (params.systemPrompt) args.push("--system-prompt", params.systemPrompt);
	return args;
}

function buildSimilarArgs(params: ExaSimilarParams): string[] {
	const args: string[] = [params.url];
	if (params.num !== undefined) args.push("--num", String(params.num));
	if (params.excludeSource) args.push("--exclude-source");
	if (params.full) args.push("--full");
	if (params.maxChars !== undefined) args.push("--max-chars", String(params.maxChars));
	return args;
}

function buildResearchArgs(params: ExaResearchParams): string[] {
	const args: string[] = [params.instructions];
	if (params.model) args.push("--model", params.model);
	if (params.maxWaitMs !== undefined) args.push("--max-wait", String(params.maxWaitMs));
	if (params.outputSchema) args.push("--output-schema", params.outputSchema);
	return args;
}

// ─── main extension export ──────────────────────────────────────────────

export default function exaExtension(pi: ExtensionAPI) {
	// ─── tools ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description:
			"Search the web with Exa. Returns titles, URLs, and highlights. Use for discovery, recent news, research, finding articles.",
		parameters: exaSearchSchema,

		async execute(_toolCallId, params: ExaSearchParams, signal, onUpdate, ctx) {
			auditNativeCall("exa_search", { query: params.query, num: params.num, days: params.days, type: params.type });
			const query = params.query.trim();
			if (!query) {
				throw new Error("exa_search: query is empty.");
			}

			const cliArgs = buildSearchArgs(params);

			onUpdate?.({
				content: [{ type: "text", text: `Searching Exa: ${query}` }],
				details: { query, cliArgs },
			});

			const { stdout, stderr, code } = await runExa(pi, "search", cliArgs, signal, ctx.cwd);

			if (code !== 0) {
				throw new Error(`exa_search failed. ${formatExaError(stdout, stderr, code)}`);
			}

			return {
				content: [{ type: "text", text: stdout.trim() }],
				details: { query, cliArgs },
			};
		},
	});

	pi.registerTool({
		name: "exa_fetch",
		label: "Exa Fetch",
		description:
			"Fetch page contents for known URLs with Exa. Returns full text, summary, or highlights. Use when you already have URLs and need to read them.",
		parameters: exaFetchSchema,

		async execute(_toolCallId, params: ExaFetchParams, signal, onUpdate, ctx) {
			auditNativeCall("exa_fetch", { urls: params.urls, mode: params.mode, livecrawl: params.livecrawl, subpages: params.subpages });
			if (!params.urls.length) {
				throw new Error("exa_fetch: urls array is empty.");
			}

			const cliArgs = buildFetchArgs(params);

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${params.urls.length} URL(s) with Exa` }],
				details: { urls: params.urls, cliArgs },
			});

			const { stdout, stderr, code } = await runExa(pi, "fetch", cliArgs, signal, ctx.cwd);

			if (code !== 0) {
				throw new Error(`exa_fetch failed. ${formatExaError(stdout, stderr, code)}`);
			}

			return {
				content: [{ type: "text", text: stdout.trim() }],
				details: { urls: params.urls, cliArgs },
			};
		},
	});

	pi.registerTool({
		name: "exa_similar",
		label: "Exa Similar",
		description:
			"Find pages similar to a given URL with Exa. Use when you have one good page and want more like it.",
		parameters: exaSimilarSchema,

		async execute(_toolCallId, params: ExaSimilarParams, signal, onUpdate, ctx) {
			auditNativeCall("exa_similar", { url: params.url, num: params.num, excludeSource: params.excludeSource });
			const url = params.url.trim();
			if (!url) {
				throw new Error("exa_similar: url is empty.");
			}

			const cliArgs = buildSimilarArgs(params);

			onUpdate?.({
				content: [{ type: "text", text: `Finding similar to: ${url}` }],
				details: { url, cliArgs },
			});

			const { stdout, stderr, code } = await runExa(pi, "similar", cliArgs, signal, ctx.cwd);

			if (code !== 0) {
				throw new Error(`exa_similar failed. ${formatExaError(stdout, stderr, code)}`);
			}

			return {
				content: [{ type: "text", text: stdout.trim() }],
				details: { url, cliArgs },
			};
		},
	});

	pi.registerTool({
		name: "exa_answer",
		label: "Exa Answer",
		description:
			"Get a synthesized answer with citations from Exa. Use for short factual questions.",
		parameters: exaAnswerSchema,

		async execute(_toolCallId, params: ExaAnswerParams, signal, onUpdate, ctx) {
			auditNativeCall("exa_answer", { question: params.question });
			const question = params.question.trim();
			if (!question) {
				throw new Error("exa_answer: question is empty.");
			}

			const cliArgs = buildAnswerArgs(params);

			onUpdate?.({
				content: [{ type: "text", text: `Asking Exa: ${question}` }],
				details: { question, cliArgs },
			});

			const { stdout, stderr, code } = await runExa(pi, "answer", cliArgs, signal, ctx.cwd);

			if (code !== 0) {
				throw new Error(`exa_answer failed. ${formatExaError(stdout, stderr, code)}`);
			}

			return {
				content: [{ type: "text", text: stdout.trim() }],
				details: { question, cliArgs },
			};
		},
	});

	pi.registerTool({
		name: "exa_research",
		label: "Exa Research",
		description:
			"Deep multi-step research with Exa. The AI plans, searches, crawls, and synthesizes a comprehensive answer. Use for complex topics needing thorough investigation.",
		parameters: exaResearchSchema,

		async execute(_toolCallId, params: ExaResearchParams, signal, onUpdate, ctx) {
			auditNativeCall("exa_research", { instructions: params.instructions, model: params.model });
			const instructions = params.instructions.trim();
			if (!instructions) {
				throw new Error("exa_research: instructions are empty.");
			}

			const cliArgs = buildResearchArgs(params);
			const model = params.model ?? "exa-research";

			onUpdate?.({
				content: [{ type: "text", text: `Starting Exa Research (${model}): ${instructions}` }],
				details: { instructions, model, cliArgs },
			});

			const { stdout, stderr, code } = await runExa(pi, "research", cliArgs, signal, ctx.cwd);

			if (code !== 0) {
				throw new Error(`exa_research failed. ${formatExaError(stdout, stderr, code)}`);
			}

			return {
				content: [{ type: "text", text: stdout.trim() }],
				details: { instructions, model, cliArgs },
			};
		},
	});

	// ─── slash commands ─────────────────────────────────────────────────

	pi.registerCommand("exa-status", {
		description: "Show whether an Exa API key is saved for the exa skill",
		handler: async (_args, ctx) => {
			try {
				const keyFile = readKeyFile();
				const saved = typeof keyFile.apiKey === "string" ? keyFile.apiKey : "";
				const envKey = process.env.EXA_API_KEY ?? "";

				const lines: string[] = [
					"Exa key status",
					"",
					`Key file: ${KEY_PATH}`,
					`  saved key:     ${saved ? maskKey(saved) : "(not set)"}`,
					`  EXA_API_KEY:   ${envKey ? maskKey(envKey) : "(not in env)"}`,
					"",
				];

				if (saved || envKey) {
					lines.push("Ready. The exa tools will pick this up automatically.");
					lines.push("Try it with: /exa  (or ask the agent to search the web)");
				} else {
					lines.push("No key found.");
					lines.push("Get one from https://dashboard.exa.ai and run:");
					lines.push("  /exa-auth <your-key>");
				}

				ctx.ui.notify(lines.join("\n"), saved || envKey ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(`Exa status error: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("exa-auth", {
		description: "Save the Exa API key for the exa skill (use --clear to forget)",
		handler: async (args, ctx) => {
			try {
				const trimmed = args.trim();

				if (trimmed === "--clear") {
					const keyFile = readKeyFile();
					delete keyFile.apiKey;
					writeKeyFile(keyFile);
					ctx.ui.notify(`Cleared Exa API key from ${KEY_PATH}.`, "info");
					return;
				}

				const provided =
					trimmed || (await ctx.ui.input("Exa API key:", ""))?.trim() || "";
				if (!provided) {
					ctx.ui.notify("No API key provided", "warning");
					return;
				}

				const keyFile = readKeyFile();
				keyFile.apiKey = provided;
				writeKeyFile(keyFile);

				ctx.ui.notify(
					[
						`Saved Exa API key to ${KEY_PATH} (${maskKey(provided)}).`,
						"The exa tools will read it from there on next call.",
						"No /reload needed — the CLI re-reads the file every time.",
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Exa auth error: ${(error as Error).message}`, "error");
			}
		},
	});
}
