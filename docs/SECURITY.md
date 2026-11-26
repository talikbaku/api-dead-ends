# Security

Back to [README](../README.md). Report a vulnerability privately via GitHub → Security → "Report a vulnerability" on this repository; please do not open a public issue.

## Threat model

| Input | Trust | How it is handled |
|---|---|---|
| Traffic data (paths, methods, statuses, dates from your logs) | **untrusted** — anyone who sends requests controls the path | control characters stripped, Markdown escaped in reports, methods limited to letters, statuses to codes, invalid dates dropped, spreadsheet formulas neutralised in CSV, IDs and token-like segments folded to `{id}` |
| Repository files (manifests, specs, route lists) | semi-trusted | service names sanitised before they reach generated commands; route lines and regexes length-capped (no ReDoS) |
| Values you pass (`--service`, `--index`…) | yours | validated before being printed into shell commands |
| MCP tool arguments (from an AI agent that may be prompt-injected) | untrusted | file access confined to the working directory after resolving symlinks; regular files ≤ 200 MB; no file content in error messages; writes only: a new `.json` from `spec_from_routes`, `init` files (never overwrites), reports under `.api-dead-ends/`; no network tools (`probe` is CLI-only) |
| `report.html` | output viewed in a browser | self-contained, Content-Security-Policy, no external resources, traffic data embedded as JSON with `<` escaped and rendered with textContent |
| `probe <url>` | network, started by you | same origin, page cap, navigation only (no clicks, no forms), logout/delete-like links skipped, fresh browser context, nothing saved, errors truncated |
| Access logs for duplicates | contain IPs | IP + user agent hashed in memory only to group requests; never written out |
| Compressed access logs | untrusted | streamed with a per-line cap, so a gzip bomb cannot exhaust memory |

## What the tool never does

No network calls (except `fetch elasticsearch` to the URL you give with the key from `ES_API_KEY`, and `probe <url>` to the site you name), no `eval`, no child processes, no changes to your code, no overwriting files without `--force`.

## Reviews

0.2.0 was reviewed before release with Anthropic's `/security-review` and an independent audit against vulnerabilities published Aug–Nov 2026 (Node.js, npm supply chain, MCP servers, agent plugins). Every confirmed finding has a regression test in `tests/security.test.mjs`.

## Recommendations for users

- Use Node.js 22 or 24 (Node 20 is end-of-life).
- Pin the version in MCP configs (`api-dead-ends@0.2.0`), never an unpinned `npx`.
- Delete raw `response.json` exports after `convert`; review `usage.csv` / reports before sharing — a secret made only of lowercase letters in a URL path cannot be told apart from a word.
