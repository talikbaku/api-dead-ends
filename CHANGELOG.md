# Changelog

## 0.2.0 — 2026-11-25

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
- `spec from-next`: Next.js routes from `app/**/route.*` and `pages/api`.
- MCP write tools `init` and `write_report` (only the config and `.api-dead-ends/`); per-command `--help`.
- Node.js 20+ (22+ recommended).

## 0.1.0 — 2026-11-20 (not released)

- Core: usage table, path templating, classes (used, rare, not seen, deprecated in use, shadow, noise), report.md/json, CI baseline, 16 source adapters.
