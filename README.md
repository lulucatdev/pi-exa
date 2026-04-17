# pi-exa

Standalone Exa integration for pi.

This package exposes Exa-powered tools for live web search, cleaned content extraction, code-context lookup, company research, and asynchronous deep research jobs.

## Installation

```bash
pi install git:github.com/lulucatdev/pi-exa
```

## Update

```bash
pi update https://github.com/lulucatdev/pi-exa.git
```

## Tools

- `exa-search`
- `exa-answer`
- `exa-contents`
- `exa-code-context`
- `exa-company-research`
- `exa-linkedin-search`
- `exa-crawl`
- `exa-deep-research-start`
- `exa-deep-research-check`

## Configuration

The extension reads `~/.pi/exa.config.json`.

The default API key environment variable is `EXA_API_KEY`. You can also save the key through `/exa-auth`.

## Notes

- Exa is intended for live web research and structured extraction tasks.
- GitHub repository content should still be handled with GitHub-native tools or generic page fetch tools instead of Exa search.

## License

MIT
