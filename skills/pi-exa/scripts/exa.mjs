#!/usr/bin/env node
/**
 * pi-exa CLI — local Node wrapper around exa-js for the `pi-exa` skill.
 *
 * Subcommands:
 *   status                                 show key state
 *   search <query>  [opts]                 web search, returns top results
 *   similar <url>   [opts]                 find pages similar to a given URL
 *   fetch  <url> [<url> ...] [opts]        fetch page contents
 *   answer <question> [opts]               synthesized answer with citations
 *   research <instructions> [opts]           deep multi-step research with Exa
 *
 * Exit codes:
 *   0  success
 *   2  user / config error (printed with EXA_* prefix on stderr)
 *   3  Exa API or network error
 *
 * Output is markdown by default for token-efficient agent consumption.
 * Pass --json on any subcommand to get raw SDK response instead.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HOME_DIR = process.env.HOME ?? process.cwd();
const KEY_PATH = path.join(HOME_DIR, ".pi", "exa.config.json");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");

// ─── helpers ──────────────────────────────────────────────────────────

function die(code, msg) {
	process.stderr.write(`${code}: ${msg}\n`);
	process.exit(code.startsWith("EXA_HTTP") || code === "EXA_NETWORK" ? 3 : 2);
}

function loadKey() {
	if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY;
	if (!existsSync(KEY_PATH)) return null;
	try {
		const f = JSON.parse(readFileSync(KEY_PATH, "utf-8"));
		return typeof f.apiKey === "string" && f.apiKey ? f.apiKey : null;
	} catch {
		return null;
	}
}

function maskKey(k) {
	if (!k) return "(missing)";
	if (k.length <= 8) return `${k.slice(0, 2)}***${k.slice(-1)}`;
	return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

async function getExa() {
	const key = loadKey();
	if (!key) {
		die(
			"EXA_KEY_MISSING",
			`No Exa API key. In pi run /exa-auth <key>, or set EXA_API_KEY in env. Key file: ${KEY_PATH}`,
		);
	}
	let mod;
	try {
		mod = await import("exa-js");
	} catch (err) {
		die(
			"EXA_SDK_MISSING",
			`Could not import exa-js (${err.message}). The skill package may not have been installed cleanly. Try: pi update https://github.com/capyup/pi-exa.git`,
		);
	}
	const Exa = mod.default ?? mod.Exa;
	return new Exa(key);
}

async function callExa(fn) {
	try {
		return await fn();
	} catch (err) {
		const msg = err?.message ?? String(err);
		// exa-js throws ExaError with .statusCode for HTTP failures
		if (typeof err?.statusCode === "number") {
			if (err.statusCode === 401 || err.statusCode === 403) {
				die("EXA_AUTH", `Exa rejected the key (${err.statusCode}): ${msg}. Run /exa-auth with a valid key.`);
			}
			if (err.statusCode === 429) {
				die("EXA_RATE_LIMIT", `Rate-limited by Exa (${err.statusCode}): ${msg}`);
			}
			die(`EXA_HTTP_${err.statusCode}`, msg);
		}
		if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(msg)) {
			die("EXA_NETWORK", msg);
		}
		die("EXA_ERROR", msg);
	}
}

function formatDate(iso) {
	if (!iso) return "";
	try {
		return new Date(iso).toISOString().slice(0, 10);
	} catch {
		return String(iso);
	}
}

function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function squish(s) {
	return String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function clip(s, n) {
	const t = squish(s);
	if (t.length <= n) return t;
	return `${t.slice(0, n - 1)}…`;
}

// Tool-output footer that nudges the model to keep source URLs in its
// reply to the user. Placed as a plain markdown trailer so it sits at the
// model's most-recent-attention window, where prompt-level instructions
// (e.g. SKILL.md description) tend to be diluted.
const SURFACE_HINT_FOOTER =
	"\n---\nCite the URL(s) above when relaying this fact to the user. URLs are part of the answer, not metadata.";

// ─── status ───────────────────────────────────────────────────────────

function cmdStatus() {
	const key = loadKey();
	const lines = [
		`Key file: ${KEY_PATH}`,
		`  exists:  ${existsSync(KEY_PATH) ? "yes" : "no"}`,
		`  key:     ${key ? maskKey(key) : "(not set)"}`,
		`  source:  ${process.env.EXA_API_KEY ? "EXA_API_KEY env var" : key ? "key file" : "(none)"}`,
		`Skill root: ${SKILL_ROOT}`,
	];
	if (!key) {
		lines.push("");
		lines.push("Get a key from https://dashboard.exa.ai and run /exa-auth <key> in pi.");
		process.stdout.write(`${lines.join("\n")}\n`);
		process.exit(2);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

// ─── search ───────────────────────────────────────────────────────────

const SEARCH_OPTS = {
	num: { type: "string", short: "n" },
	days: { type: "string" },
	from: { type: "string" },
	to: { type: "string" },
	domain: { type: "string", multiple: true },
	exclude: { type: "string", multiple: true },
	category: { type: "string", short: "c" },
	type: { type: "string", short: "t" }, // auto | neural | keyword | hybrid | deep-lite | deep | deep-reasoning
	full: { type: "boolean" },
	"max-chars": { type: "string" },
	"system-prompt": { type: "string" },
	"output-schema": { type: "string" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
};

const SEARCH_HELP = `usage: exa search "<query>" [options]

  -n, --num N            number of results (default 5, max 25)
      --days N           restrict to last N days (computes startPublishedDate)
      --from YYYY-MM-DD  explicit start published date
      --to   YYYY-MM-DD  explicit end published date
      --domain D         include domain (repeatable)
      --exclude D        exclude domain (repeatable)
  -c, --category C       news | research paper | company | pdf | personal site | tweet | github
  -t, --type T           auto (default) | neural | keyword | hybrid | deep-lite | deep | deep-reasoning
      --full             return full text (~5000 chars / result) instead of highlights
      --max-chars N      override text char budget per result (with --full)
      --system-prompt S  system prompt to guide the LLM (deep search types only)
      --output-schema J  JSON schema for structured deep-search output
      --json             machine-readable JSON instead of markdown
`;

async function cmdSearch(argv) {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: SEARCH_OPTS, allowPositionals: true });
	} catch (e) {
		die("EXA_USAGE", e.message);
	}
	if (parsed.values.help) {
		process.stdout.write(SEARCH_HELP);
		return;
	}
	const query = parsed.positionals.join(" ").trim();
	if (!query) die("EXA_USAGE", `Missing query.\n${SEARCH_HELP}`);

	const numResults = Math.min(25, Math.max(1, Number(parsed.values.num ?? 5)));
	const opts = {
		type: parsed.values.type ?? "auto",
		numResults,
	};
	if (parsed.values.domain?.length) opts.includeDomains = parsed.values.domain;
	if (parsed.values.exclude?.length) opts.excludeDomains = parsed.values.exclude;
	if (parsed.values.category) opts.category = parsed.values.category;
	if (parsed.values.from) opts.startPublishedDate = parsed.values.from;
	if (parsed.values.to) opts.endPublishedDate = parsed.values.to;
	if (parsed.values.days) {
		const d = Number(parsed.values.days);
		if (Number.isFinite(d) && d > 0) {
			const since = new Date(Date.now() - d * 86400 * 1000).toISOString().slice(0, 10);
			opts.startPublishedDate = since;
		}
	}
	if (parsed.values.full) {
		const max = Number(parsed.values["max-chars"] ?? 5000);
		opts.contents = { text: { maxCharacters: max } };
	} else {
		opts.contents = { highlights: { numSentences: 3, highlightsPerUrl: 2 } };
	}
	if (parsed.values["system-prompt"]) opts.systemPrompt = parsed.values["system-prompt"];
	if (parsed.values["output-schema"]) {
		try {
			opts.outputSchema = JSON.parse(parsed.values["output-schema"]);
		} catch (e) {
			die("EXA_USAGE", `Invalid --output-schema JSON: ${e.message}`);
		}
	}

	const exa = await getExa();
	const res = await callExa(() => exa.search(query, opts));

	if (parsed.values.json) {
		process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
		return;
	}

	const lines = [];
	lines.push(`# Exa search: ${query}`);
	const count = res.results?.length ?? 0;
	if (!count) {
		lines.push("");
		lines.push("No results.");
		process.stdout.write(`${lines.join("\n")}\n`);
		return;
	}
	res.results.forEach((r, i) => {
		const head = [
			`${i + 1}. ${squish(r.title) || "(no title)"}`,
			hostOf(r.url),
			formatDate(r.publishedDate),
		]
			.filter(Boolean)
			.join(" — ");
		lines.push("");
		lines.push(head);
		lines.push(`   ${r.url}`);
		if (parsed.values.full) {
			const text = clip(r.text ?? "", Number(parsed.values["max-chars"] ?? 5000));
			if (text) lines.push(`   ${text.replace(/\n/g, "\n   ")}`);
		} else {
			const highlights = Array.isArray(r.highlights) ? r.highlights : [];
			for (const h of highlights) {
				lines.push(`   • ${clip(h, 350)}`);
			}
			if (!highlights.length && r.summary) {
				lines.push(`   • ${clip(r.summary, 350)}`);
			}
		}
	});
	if (res.costDollars?.total != null) {
		lines.push("");
		lines.push(`_cost: $${res.costDollars.total.toFixed(4)}_`);
	}
	lines.push(SURFACE_HINT_FOOTER);
	process.stdout.write(`${lines.join("\n")}\n`);
}

// ─── fetch ────────────────────────────────────────────────────────────

const FETCH_OPTS = {
	mode: { type: "string", short: "m" }, // text | summary | highlights
	"max-chars": { type: "string" },
	livecrawl: { type: "string" }, // never | fallback | always | auto | preferred
	subpages: { type: "string" },
	"subpage-target": { type: "string" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
};

const FETCH_HELP = `usage: exa fetch <url> [<url> ...] [options]

  -m, --mode MODE      text (default) | summary | highlights
      --max-chars N    char budget per page (default 5000 for text)
      --livecrawl M    never | fallback | always | auto | preferred (default: auto)
      --subpages N     number of subpages to extract per URL (0-10)
      --subpage-target T  fuzzy text to match subpages (e.g. "about")
      --json           machine-readable JSON instead of markdown
`;

async function cmdFetch(argv) {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: FETCH_OPTS, allowPositionals: true });
	} catch (e) {
		die("EXA_USAGE", e.message);
	}
	if (parsed.values.help) {
		process.stdout.write(FETCH_HELP);
		return;
	}
	const urls = parsed.positionals;
	if (!urls.length) die("EXA_USAGE", `Missing URL.\n${FETCH_HELP}`);

	const mode = parsed.values.mode ?? "text";
	const max = Number(parsed.values["max-chars"] ?? 5000);
	const opts = {};
	if (mode === "text") opts.text = { maxCharacters: max };
	else if (mode === "summary") opts.summary = true;
	else if (mode === "highlights") opts.highlights = { numSentences: 3, highlightsPerUrl: 3 };
	else die("EXA_USAGE", `Unknown --mode: ${mode}`);
	if (parsed.values.livecrawl) opts.livecrawl = parsed.values.livecrawl;
	if (parsed.values.subpages) opts.subpages = Number(parsed.values.subpages);
	if (parsed.values["subpage-target"]) opts.subpageTarget = parsed.values["subpage-target"];

	const exa = await getExa();
	const res = await callExa(() => exa.getContents(urls, opts));

	if (parsed.values.json) {
		process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
		return;
	}

	const lines = [];
	const results = res.results ?? [];
	if (!results.length) {
		process.stdout.write("No content returned.\n");
		return;
	}
	results.forEach((r, i) => {
		if (i > 0) lines.push("\n---\n");
		lines.push(`# ${squish(r.title) || r.url}`);
		lines.push(`URL: ${r.url}`);
		if (r.publishedDate) lines.push(`Published: ${formatDate(r.publishedDate)}`);
		lines.push("");
		if (mode === "text" && r.text) {
			lines.push(clip(r.text, max));
		} else if (mode === "summary" && r.summary) {
			lines.push(squish(r.summary));
		} else if (mode === "highlights") {
			const hls = Array.isArray(r.highlights) ? r.highlights : [];
			for (const h of hls) lines.push(`- ${clip(h, 400)}`);
		}
	});
	lines.push(SURFACE_HINT_FOOTER);
	process.stdout.write(`${lines.join("\n")}\n`);
}

// ─── answer ───────────────────────────────────────────────────────────

const ANSWER_OPTS = {
	location: { type: "string", short: "l" },
	model: { type: "string" },
	"system-prompt": { type: "string" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
};

const ANSWER_HELP = `usage: exa answer "<question>" [options]

  -l, --location CC    ISO country code for location-aware answers (e.g. US, JP)
      --model NAME     override answer model (default exa)
      --system-prompt S  system prompt to guide the answer style
      --json           machine-readable JSON instead of markdown
`;

async function cmdAnswer(argv) {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: ANSWER_OPTS, allowPositionals: true });
	} catch (e) {
		die("EXA_USAGE", e.message);
	}
	if (parsed.values.help) {
		process.stdout.write(ANSWER_HELP);
		return;
	}
	const question = parsed.positionals.join(" ").trim();
	if (!question) die("EXA_USAGE", `Missing question.\n${ANSWER_HELP}`);

	const opts = { text: true };
	if (parsed.values.location) opts.userLocation = parsed.values.location;
	if (parsed.values.model) opts.model = parsed.values.model;
	if (parsed.values["system-prompt"]) opts.systemPrompt = parsed.values["system-prompt"];

	const exa = await getExa();
	const res = await callExa(() => exa.answer(question, opts));

	if (parsed.values.json) {
		process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
		return;
	}

	const lines = [];
	lines.push(squish(res.answer ?? "(no answer returned)"));
	const cites = Array.isArray(res.citations) ? res.citations : [];
	if (cites.length) {
		lines.push("");
		lines.push("Citations:");
		cites.forEach((c, i) => {
			const title = squish(c.title) || hostOf(c.url) || c.url;
			lines.push(`  [${i + 1}] ${title} — ${c.url}`);
		});
	}
	lines.push(SURFACE_HINT_FOOTER);
	process.stdout.write(`${lines.join("\n")}\n`);
}

// ─── similar ────────────────────────────────────────────────────────────

const SIMILAR_OPTS = {
	num: { type: "string", short: "n" },
	"exclude-source": { type: "boolean" },
	full: { type: "boolean" },
	"max-chars": { type: "string" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
};

const SIMILAR_HELP = `usage: exa similar <url> [options]

  -n, --num N            number of similar results (default 5, max 25)
      --exclude-source   do not include the source URL itself in results
      --full             return full text (~5000 chars / result)
      --max-chars N      override text char budget per result (with --full)
      --json             machine-readable JSON instead of markdown
`;

async function cmdSimilar(argv) {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: SIMILAR_OPTS, allowPositionals: true });
	} catch (e) {
		die("EXA_USAGE", e.message);
	}
	if (parsed.values.help) {
		process.stdout.write(SIMILAR_HELP);
		return;
	}
	const url = parsed.positionals[0]?.trim();
	if (!url) die("EXA_USAGE", `Missing URL.\n${SIMILAR_HELP}`);

	const numResults = Math.min(25, Math.max(1, Number(parsed.values.num ?? 5)));
	const opts = { numResults };
	if (parsed.values["exclude-source"]) opts.excludeSourceDomain = true;
	if (parsed.values.full) {
		const max = Number(parsed.values["max-chars"] ?? 5000);
		opts.contents = { text: { maxCharacters: max } };
	} else {
		opts.contents = { highlights: { numSentences: 3, highlightsPerUrl: 2 } };
	}

	const exa = await getExa();
	const res = await callExa(() => exa.findSimilar(url, opts));

	if (parsed.values.json) {
		process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
		return;
	}

	const lines = [];
	lines.push(`# Exa similar to: ${url}`);
	const count = res.results?.length ?? 0;
	if (!count) {
		lines.push("");
		lines.push("No similar results.");
		process.stdout.write(`${lines.join("\n")}\n`);
		return;
	}
	res.results.forEach((r, i) => {
		const head = [
			`${i + 1}. ${squish(r.title) || "(no title)"}`,
			hostOf(r.url),
			formatDate(r.publishedDate),
		]
			.filter(Boolean)
			.join(" — ");
		lines.push("");
		lines.push(head);
		lines.push(`   ${r.url}`);
		if (parsed.values.full) {
			const text = clip(r.text ?? "", Number(parsed.values["max-chars"] ?? 5000));
			if (text) lines.push(`   ${text.replace(/\n/g, "\n   ")}`);
		} else {
			const highlights = Array.isArray(r.highlights) ? r.highlights : [];
			for (const h of highlights) {
				lines.push(`   • ${clip(h, 350)}`);
			}
			if (!highlights.length && r.summary) {
				lines.push(`   • ${clip(r.summary, 350)}`);
			}
		}
	});
	if (res.costDollars?.total != null) {
		lines.push("");
		lines.push(`_cost: $${res.costDollars.total.toFixed(4)}_`);
	}
	lines.push(SURFACE_HINT_FOOTER);
	process.stdout.write(`${lines.join("\n")}\n`);
}

// ─── research ───────────────────────────────────────────────────────────

const RESEARCH_OPTS = {
	model: { type: "string", short: "m" }, // exa-research-fast | exa-research | exa-research-pro
	"max-wait": { type: "string" },
	"output-schema": { type: "string" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
};

const RESEARCH_HELP = `usage: exa research "<instructions>" [options]

  -m, --model MODEL    exa-research-fast | exa-research (default) | exa-research-pro
      --max-wait MS    max time to wait for completion in ms (default 300000 = 5min)
      --output-schema J  JSON schema for structured research output
      --json           machine-readable JSON instead of markdown
`;

async function cmdResearch(argv) {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: RESEARCH_OPTS, allowPositionals: true });
	} catch (e) {
		die("EXA_USAGE", e.message);
	}
	if (parsed.values.help) {
		process.stdout.write(RESEARCH_HELP);
		return;
	}
	const instructions = parsed.positionals.join(" ").trim();
	if (!instructions) die("EXA_USAGE", `Missing instructions.\n${RESEARCH_HELP}`);

	const model = parsed.values.model ?? "exa-research";
	const maxWait = Number(parsed.values["max-wait"] ?? 300_000);
	const pollInterval = 5_000;

	const exa = await getExa();

	// Build create params
	const createParams = { instructions, model };
	if (parsed.values["output-schema"]) {
		try {
			createParams.outputSchema = JSON.parse(parsed.values["output-schema"]);
		} catch (e) {
			die("EXA_USAGE", `Invalid --output-schema JSON: ${e.message}`);
		}
	}

	// Create the research request
	process.stderr.write(`Creating research request...\n`);
	const created = await callExa(() => exa.research.create(createParams));
	const researchId = created.researchId;
	process.stderr.write(`Research ID: ${researchId} (status: ${created.status})\n`);

	// Poll until finished
	const start = Date.now();
	let lastStatus = created.status;
	while (Date.now() - start < maxWait) {
		await new Promise((r) => setTimeout(r, pollInterval));
		const status = await callExa(() => exa.research.get(researchId));
		if (status.status !== lastStatus) {
			lastStatus = status.status;
			process.stderr.write(`Status: ${lastStatus}\n`);
		}
		if (status.status === "completed" || status.status === "failed" || status.status === "canceled") {
			// finished
			if (parsed.values.json) {
				process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
				return;
			}

			const lines = [];
			lines.push(`# Exa Research: ${instructions}`);
			lines.push(`Model: ${model}`);
			lines.push(`Status: ${status.status}`);
			lines.push(`Research ID: ${researchId}`);

			if (status.status === "completed") {
				const output = status.output;
				if (output?.content) {
					lines.push("");
					lines.push("---");
					lines.push("");
					lines.push(squish(output.content));
				}
				if (status.costDollars) {
					lines.push("");
					lines.push(
						`_Cost: $${status.costDollars.total.toFixed(4)} | ` +
						`searches: ${status.costDollars.numSearches} | ` +
						`pages: ${status.costDollars.numPages} | ` +
						`tokens: ${status.costDollars.reasoningTokens}_`,
					);
				}
			} else if (status.status === "failed") {
				lines.push("");
				lines.push(`Error: ${status.error || "Unknown error"}`);
			} else {
				lines.push("");
				lines.push("Research was canceled.");
			}

			process.stdout.write(`${lines.join("\n")}\n`);
			return;
		}
	}

	// timeout — return the ID so caller can poll later
	die(
		"EXA_TIMEOUT",
		`Research ${researchId} did not finish within ${maxWait}ms. ` +
			`Current status: ${lastStatus}. Resume polling manually or re-run with --max-wait.`,
	);
}

// ─── help ─────────────────────────────────────────────────────────────

const TOP_HELP = `pi-exa CLI — Exa web research

usage: exa <subcommand> [options]

Subcommands:
  status                 show whether the API key is configured
  search "<query>"       semantic web search; returns titles + URLs + highlights
  similar <url>            find pages similar to the given URL
  fetch  <url> [...]       fetch page text / summary / highlights for known URLs
  answer "<question>"      synthesized answer with citations
  research "<instructions>"  deep multi-step research with automated search & analysis

Run "exa <subcommand> --help" for subcommand-specific options.
Key file: ${KEY_PATH}
`;

// ─── dispatch ─────────────────────────────────────────────────────────

const sub = process.argv[2];
let rest = process.argv.slice(3);

// Strip the internal audit marker (used by the native extension to label
// CLI invocations that originated from a native tool call). Race-free
// because it is per-argv, not env-var.
const _auditInternalIdx = rest.indexOf("--_audit_internal");
const _auditIsInternal = _auditInternalIdx >= 0;
if (_auditIsInternal) rest.splice(_auditInternalIdx, 1);

// Silent audit hook: writes a JSON line to PI_EXA_AUDIT_LOG when set.
// The agent never sees this; it only fires when an external harness enables it.
// source labels:
//   cli_internal — spawned by an extension's native tool call (de-dup signal)
//   cli_direct   — invoked directly via bash by the agent
if (sub && !["-h", "--help", "help", "status"].includes(sub) && process.env.PI_EXA_AUDIT_LOG) {
	try {
		const { appendFileSync } = await import("node:fs");
		const cliSource = _auditIsInternal ? "cli_internal" : "cli_direct";
		appendFileSync(
			process.env.PI_EXA_AUDIT_LOG,
			JSON.stringify({
				ts: new Date().toISOString(),
				run_id: process.env.PI_EXA_AUDIT_RUN_ID ?? "",
				pid: process.pid,
				source: cliSource,
				tool: `exa_${sub}`,
				argv: rest,
			}) + "\n",
		);
	} catch {
		// never let audit failure break the CLI
	}
}

switch (sub) {
	case undefined:
	case "-h":
	case "--help":
	case "help":
		process.stdout.write(TOP_HELP);
		break;
	case "status":
		cmdStatus();
		break;
	case "search":
		await cmdSearch(rest);
		break;
	case "fetch":
		await cmdFetch(rest);
		break;
	case "answer":
		await cmdAnswer(rest);
		break;
	case "similar":
		await cmdSimilar(rest);
		break;
	case "research":
		await cmdResearch(rest);
		break;
	default:
		die("EXA_USAGE", `Unknown subcommand: ${sub}\n${TOP_HELP}`);
}
