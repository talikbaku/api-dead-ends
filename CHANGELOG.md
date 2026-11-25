# Changelog

## 0.2.0 — unreleased

- `init`: step-by-step setup wizard (interactive, `--yes`, `--json`, `--dry-run`); scans polyglot repos per service.
- `spec from-routes`: OpenAPI from framework route lists (Rails, Flask, Django, Spring, Gin, Echo, Fiber, Laravel, Express, Next.js `[id]`).
- Reports: summary block, server errors with threshold rule, 5xx below threshold, client errors, undocumented incl. words on parameters, debug/admin path flags, terminal summary.
- MCP server (`mcp`), Claude Code plugin with the `api-health` skill, UTCP manual (experimental), prompt for any AI.
- Security hardening after review: confined MCP file access, sanitised traffic data, validated shell values, ReDoS and gzip-bomb protection.
- Node.js 20+ (22+ recommended).

## 0.1.0 — 2026-11-20 (not released)

- Core: usage table, path templating, classes (used, rare, not seen, deprecated in use, shadow, noise), report.md/json, CI baseline, 16 source adapters.
