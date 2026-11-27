# Changelog

## Unreleased

- `report.html`: the 5xx share says "over threshold" / "below threshold" next to the number (not colour only); short sparkline labels (total, peak day, last N days); font sizes in rem; Windows High Contrast (`forced-colors`) styles. Checked with axe-core (0 violations), a keyboard run and Chromium forced-colours emulation.
- `report.md` has per-day tables (calls and 5xx) for endpoints with 5xx or spikes; `report.json` gets `perDay` for every endpoint when the data has days.
- `-o -` writes to stdout for every command (no file named `-`); `spec from-*` and `convert -o` now write through the same symlink-safe writer as the rest; clearer errors when the target is a directory or a symlink.
- `init`: NEXT-STEPS no longer says `probe` is unavailable; a warning when `--source` is not what the service's manifests show.
- README badges have meaningful alt text; Node badge added.
- The UTCP manual version follows the package version; a test checks every pinned version in the docs and the plugin manifest.
- `report.html` accessibility: WAI-ARIA tabs with arrow keys, Home and End; Overview tiles and "Look at first" rows are keyboard buttons; focus kept after redraws; visible focus outline; table captions and header scope; text alternative for sparklines; `aria-pressed` on the time window; text colours raised to WCAG AA 4.5:1 in light and dark mode (checked with axe-core: 0 violations). See ACCESSIBILITY.md.
- GitHub community files: code of conduct, contributing, issue and PR templates, accessibility statement.

## 0.2.0 — 2026-11-26

- `init`: step-by-step setup wizard (interactive, `--yes`, `--json`, `--dry-run`); scans polyglot repos per service.
- `spec from-routes`: OpenAPI from framework route lists (Rails, Flask, Django, Spring, Gin, Echo, Fiber, Laravel, Express, Next.js `[id]`).
- Reports: summary block, server errors with threshold rule, 5xx below threshold, client errors, undocumented incl. words on parameters, debug/admin path flags, terminal summary.
- MCP server (`mcp`), Claude Code plugin with the `api-health` skill, UTCP manual (tested with the UTCP Python client), prompt for any AI.
- Security hardening after review: confined MCP file access, sanitised traffic data, validated shell values, ReDoS and gzip-bomb protection.
- Per-day usage (`--daily`), 30/7/3/1-day windows and recent 5xx spikes; self-contained `report.html`.
- `probe <url>`: front-end API calls sent several times per page load, broken and slow calls, spec coverage (Playwright, optional).
- Duplicates: repeated POST/PUT/PATCH/DELETE from one client in access logs (`convert accesslog --duplicates`).
- Not logged: `coverage` (ingress/APM vs app logs) and `logging-check` (explicit "do not log" settings in code and config).
- VictoriaLogs source (LogsQL); Nuxt detection.
- "What changed today" (`--hourly`): today vs the same hours on previous days, first error hour, traffic changes; error texts behind 5xx via traces (`fetch kibana --errors`); `--tz`; spikes compare with the days before; `--include-today`.
- `fetch kibana`: export through a browser login to Kibana (no ES URL or API key needed).
- `fetch victorialogs`: VictoriaLogs over HTTP (read-only LogsQL); method/path/status/trace fields detected from the data (Kong, APISIX, nginx, Envoy, OpenTelemetry names); IDs folded on the server; `--hourly`, `--errors` (error texts from app logs in the same traces), `--tenant`, `VL_AUTH`.
- What changed: peak req/s today vs before, "calls and 5xx up together"; the last hour of an export made mid-hour is not compared.
- After review: "before" averaged per hour over the days that have it (partial first day no longer halves it); error-text failures no longer lose the usage table; error texts look in all services of the same traces and ignore placeholder trace ids; masking covers JWTs, credentials, query strings, IPs and long tokens; Prometheus hourly/daily points labelled by the start of their step; numeric flags validated; HTML opens on "What changed today" when 5xx went up.
- `spec from-next`: Next.js routes from `app/**/route.*` and `pages/api`.
- MCP write tools `init` and `write_report` (only the config and `.api-dead-ends/`); per-command `--help`.
- Node.js 20+ (22+ recommended).

## 0.1.0 — 2026-11-20 (not released)

- Core: usage table, path templating, classes (used, rare, not seen, deprecated in use, shadow, noise), report.md/json, CI baseline, 16 source adapters.
