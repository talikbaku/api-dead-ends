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
| `logging-probe send` / `verify` | network, started by you | `send`: staging only, to the URL you name; one marked GET/HEAD per spec operation by default; write methods only with both `--include-writes` and `--i-understand-this-is-staging`; redirects never followed; rate cap (default 2, at most 50 requests per second); header values you pass are never stored in the run file. `verify`: log exports are untrusted and streamed |
| YAML specs (`--spec openapi.yaml`, MCP `spec`) | untrusted | built-in reader; alias expansion capped (no alias bomb), nesting depth and size capped, the key `__proto__` refused, error messages give a line number and never quote file content |
| Access logs for duplicates | contain IPs | IP + user agent hashed in memory only to group requests; never written out |
| Compressed access logs | untrusted | streamed with a per-line cap, so a gzip bomb cannot exhaust memory |

## What the tool never does

No network calls (except `fetch elasticsearch` to the URL you give with the key from `ES_API_KEY`, `fetch kibana` through your own browser login, `fetch victorialogs` to the URL you give — read-only LogsQL, optional `VL_AUTH` header, refused over plain http to anything but localhost, no redirects — `probe <url>` to the site you name, and `logging-probe send --url` to the staging URL you name — one marked GET/HEAD per spec operation, rate-limited, no redirects followed, response bodies not read; writes only with `--include-writes --i-understand-this-is-staging`), no `eval`, no child processes, no changes to your code, no overwriting files without `--force` (`init`; outputs you name with `-o`/`--out` are replaced, but never through a symlink).

Error texts (`--errors`) are free text from your logs. They are masked (UUIDs, numbers, e-mails, IPs, JWTs, bearer/basic credentials, `token=`/`password=` values, URL query strings, long mixed tokens, database key values) and cut to 200 characters, but masking is a safety net, not a guarantee: read `errors.json` before you share a report. Trace ids that look like placeholders (`-`, `null`, short or repetitive values) are ignored, so a client cannot pull other services' logs into your report by sending a common request id.

## Reviews

0.3.0 was reviewed before release with Anthropic's `/security-review` (no findings), five independent reviewers (YAML against 315 real public specs, security, QA, docs, product) with every finding re-checked, and an audit against vulnerabilities published Aug 27 – Nov 27, 2026 (Node.js October/November security releases, js-yaml merge/alias DoS, MCP SDK and Registry, Claude Code plugin pinning, npm Trusted Publishing, URL-concatenation SSRF, terminal escape injection). Fixed: YAML aliases could amplify strings and nesting past the limits (now capped by nodes, characters and depth); a Swagger `basePath` could move `logging-probe` requests to another host or port; spec paths could inject terminal escapes. Runtime: Node's `fetch` decodes Brotli even when the body is discarded (CVE-2026-111497), so `logging-probe send` uses `node:http`; `fetch elasticsearch`/`victorialogs` still use `fetch` — use Node 22.23.5+ / 24.22.3+ (Node 20 gets no fixes). Confirmed findings have regression tests in `tests/security.test.mjs`.

0.2.0 was reviewed before release with Anthropic's `/security-review` and an independent audit against vulnerabilities published Aug–Nov 2026 (Node.js, npm supply chain, MCP servers, agent plugins). Every confirmed finding has a regression test in `tests/security.test.mjs`.

## Recommendations for users

- Use Node.js 22 or 24 (Node 20 is end-of-life).
- Pin the version in MCP configs (`api-dead-ends@0.3.0`), never an unpinned `npx`.
- Delete raw `response.json` exports after `convert`; review `usage.csv` / reports before sharing — a secret made only of lowercase letters in a URL path cannot be told apart from a word.
