# pi-exa

Exa web research for [pi](https://github.com/badlogic/pi-mono), via a small
**skill + local CLI**. Calls Exa directly through the official
[`exa-js`](https://www.npmjs.com/package/exa-js) SDK — no MCP server, no
adapter, no `mcp.json` to provision.

## Why this design

Web-search tools are a context-cost trap. The natural instinct is to
register `exa-search`, `exa-fetch`, `exa-answer` etc. as first-class tools
so the model can call them directly — but that means **every tool's
JSON schema and description sits in the system prompt for every turn**,
even on sessions that never search anything. v0.1.x of pi-exa registered
nine such tools (~750 tokens permanent); v0.2.x switched to MCP and got
that down to ~400 tokens but introduced its own fragility (an opaque
remote MCP server, an `mcp.json` file that has to exist or all tools
disappear, an adapter dependency).

v0.3 takes a different shape:

- A **skill** (`skills/exa/SKILL.md`) lives at the metadata layer — only
  its name and description (~120 tokens) sit in the system prompt
  permanently. The body loads on demand when the agent decides a task
  matches.
- A **local Node CLI** (`skills/exa/scripts/exa.mjs`) does the actual
  work, importing `exa-js` directly. The agent invokes it through `bash`,
  reads the markdown output, moves on.
- A tiny **extension** (`extensions/exa/index.ts`) only exposes
  `/exa-auth` and `/exa-status`. No `registerTool`, no MCP config, no
  state.

Permanent context cost: **~120 tokens** for the skill metadata. Detailed
usage instructions only enter context when the skill triggers.

## Install

```bash
pi install npm:@capyup/pi-exa
```

(Or `pi install git:github.com/capyup/pi-exa` if you want to track `main`
directly.)

Either form pulls `exa-js` and registers the extension and the skill.

Then save your API key (get one from <https://dashboard.exa.ai>):

```text
/exa-auth <your-exa-api-key>
```

That's it. The CLI re-reads the key file on every call, so no `/reload`
is needed.

To verify:

```text
/exa-status
```

## Usage

You don't normally invoke this directly — the skill activates whenever a
prompt looks like web research and tells the agent to use the bundled
CLI. If you want to force-load the skill instructions or use it
directly:

```text
/skill:pi-exa
```

The CLI itself is plain shell:

```bash
# from the skill directory:
./scripts/exa.mjs status
./scripts/exa.mjs search "anthropic claude code release notes" --days 30 --num 5
./scripts/exa.mjs fetch https://exa.ai/docs/sdks/javascript-sdk --mode summary
./scripts/exa.mjs answer "Who is the current CEO of Anthropic?"
```

Add `--help` to any subcommand for the full option list.

## Slash commands

| Command | What it does |
| --- | --- |
| `/exa-auth <key>` | Save the Exa API key to `~/.pi/exa.config.json` (mode `0600`). |
| `/exa-auth --clear` | Forget the saved key. |
| `/exa-status` | Show whether a key is in place and where it came from. |

## Files this package owns

- `~/.pi/exa.config.json` — stores `{ "apiKey": "..." }`. Mode `0600`.
  Other fields are preserved but not used.

This package does **not** touch `~/.pi/agent/mcp.json`,
`~/.config/mcp/mcp.json`, `.mcp.json`, or `.pi/mcp.json`.

If you used v0.2.x and have an `mcpServers.exa` entry in
`~/.pi/agent/mcp.json` that you no longer want, delete it manually — pi-exa
will not.

## Migration from v0.2.x (MCP) and v0.1.x (bespoke tools)

1. `pi update npm:@capyup/pi-exa` (or `pi update https://github.com/capyup/pi-exa.git` if you installed from git)
2. Your existing key in `~/.pi/exa.config.json` is reused; no need to
   re-run `/exa-auth` unless you want to change it.
3. (Optional) Open `~/.pi/agent/mcp.json` and remove the `exa` entry
   under `mcpServers` — pi-exa no longer manages or needs it.
4. (Optional) `pi remove npm:pi-mcp-adapter` if no other package uses it.
5. Restart pi or `/reload`. The skill will now show up in your
   `available_skills` list.

**Tool name remap (v0.1.x → v0.3.x):** there are no tools to remap. The
agent decides when to invoke `scripts/exa.mjs` based on the skill
description; it doesn't need a 1:1 replacement for the old tool names.

## Token-cost comparison

| Version | Permanent context cost | Failure modes |
| --- | --- | --- |
| v0.1.x (9 bespoke tools + routing prose) | ~750 tokens | tool name drift; you-pay-even-if-unused |
| v0.2.x (MCP, 2 direct tools) | ~400 tokens + MCP proxy overhead | mcp.json missing; remote MCP unreachable; adapter version mismatch |
| **v0.3.x (skill + CLI)** | **~120 tokens** (skill metadata) | key file missing (clear error from CLI) |

## License

MIT
