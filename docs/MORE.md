# api-dead-ends — more

Everything that does not fit on the front page. Back to [README](../README.md).

## Setup with `init`

```bash
npx api-dead-ends init
```

`init` runs in your repository root and:

1. **Scans** the repo (read-only): services, languages, frameworks, OpenAPI files, hints like `dd-trace`, `prometheus`, `elasticsearch` in your manifests and compose files. Monorepos with several languages give one entry per service.
2. **Asks** a few questions — press Enter to accept the default in brackets:
   - where your traffic is (Elasticsearch/Kibana, Datadog APM or Logs, Prometheus, Loki, App Insights, CloudWatch, New Relic, Dynatrace, Splunk, access log files, any CSV, or nothing yet);
   - which services to include and their names in that tool;
   - the OpenAPI JSON for each service, or a route list file if there is no spec;
   - the window in days;
   - whether to write instructions for your AI assistant.
3. **Writes** `api-dead-ends.config.json` and `.api-dead-ends/NEXT-STEPS.md` with the exact commands for every service. It never changes your code and never overwrites files without `--force`.

Then follow `NEXT-STEPS.md`. For most sources it is three commands: print the query → run it in your tool and save the response → `convert` and `report`.

`init --help` lists all flags. For Elasticsearch, `--access paste` (default) means: the tool prints a query, you run it in Kibana Dev Tools and save the response — no key needed; `--access api-key` pulls directly with a read-only key in `ES_API_KEY`. Without a terminal, `init` refuses to guess: pipe answers (one per line) or add `--yes`.

### Already have an export?

If a colleague already saved the response from Kibana, Datadog, Prometheus… skip `init`:

```bash
api-dead-ends convert elasticsearch kibana-response.json --spec openapi.json -o usage.csv
api-dead-ends report --usage usage.csv --spec openapi.json --days 15 --out report/
```

`--days` is the length of the export window; without it the report says "unknown window" when the source has no dates.

Non-interactive (CI, scripts, AI agents):

```bash
api-dead-ends init --yes --source datadog-apm --service orders --days 90   # defaults + flags, writes files
api-dead-ends init --yes --source accesslog --service accounts --routes routes.txt --logs access.log   # no spec + log files
api-dead-ends init --yes --json --dry-run --source elasticsearch    # plan as JSON, writes nothing
```

### No OpenAPI spec?

Ask your framework for its route list and build a spec from it — no code parsing involved:

| Framework | Command | Then |
|---|---|---|
| Spring Boot | `curl localhost:8080/v3/api-docs > openapi.json` (springdoc) or `/actuator/mappings > routes.json` | use it / `spec from-routes` |
| FastAPI | `curl localhost:8000/openapi.json > openapi.json` | use it |
| Django | `python manage.py show_urls > routes.txt` | `spec from-routes` |
| Flask | `flask routes > routes.txt` | `spec from-routes` |
| Rails | `bin/rails routes > routes.txt` | `spec from-routes` |
| Laravel | `php artisan route:list --json > routes.json` | `spec from-routes` |
| Gin | the `[GIN-debug] GET /x --> …` lines at startup → `routes.txt` | `spec from-routes` |
| Echo / Fiber / Hono | print `e.Routes()` / `app.GetRoutes()` / `app.routes` as JSON | `spec from-routes` |
| Express 4 | `express-list-endpoints(app)` as JSON | `spec from-routes` |
| NestJS / Fastify / ASP.NET | Swagger JSON endpoint | use it |
| anything | lines like `GET /users/{id}` | `spec from-routes` |

```bash
api-dead-ends spec from-routes routes.txt -o openapi.json
```

## Classes and thresholds

| Class | Meaning |
|---|---|
| server errors | ≥ 1% **and** ≥ 10 responses are 5xx (`--error-share`, `--error-min`); smaller 5xx counts are listed separately |
| client errors | ≥ 10% of calls end in 4xx other than 401/404 (validation, conflicts) |
| possibly separate routes | a word in the path (`/orders/export`) landed on a parameter (`/orders/{id}`): check whether it is its own route |
| `not_seen` | no calls in the window — a hint, **not a verdict**: it may be rare, or its traffic may not be logged |
| `rare` | fewer than `--rare` calls (default 100) |
| `deprecated_in_use` | marked `deprecated` in the spec but still called |
| shadow | called, but missing from the spec (path or method) |
| `used` | everything else |

Noise is set aside: `OPTIONS`/`HEAD` preflights, scanners (`/wp-*`, `/.env`), and unknown paths that only ever returned 404/405.

`report --out DIR` writes `report.md` and `report.json`; `report --json` prints the JSON.

## Path templating

Paths are folded before comparison: numbers, UUIDs, ULIDs, long hex, anything with digits of 6+ characters, e-mail-like segments and token-like segments (`sk_live_…`, long mixed-case strings) become `{id}`. Query strings, fragments, `;matrix` params and encoded `?` are dropped. Literal segments from your spec (`oauth2`, `2024`) are never folded. A word that lands on a spec parameter (`/orders/export` vs `/orders/{id}`) is reported as a possible separate route instead of being counted into `{id}`.

## No logs at all?

Without traffic there is no report — an empty table would mark every endpoint "not called". Options today:

- **Web server / ingress access logs** (nginx, Apache, ALB): use the `accesslog` source.
- **Anything that already collects traces or metrics** (Datadog, Prometheus, OpenTelemetry, New Relic…): pick that source. For services that collect nothing, OpenTelemetry is the standard way to start: Java needs only an agent at startup; Python, Ruby, .NET and Go have auto-instrumentation.
- **Next.js on Vercel:** runtime logs are short-lived (about 1 hour on Hobby, 1 day on Pro). Use a log drain (Pro) or OpenTelemetry (`@vercel/otel`) to a backend, then pick that source.
- Planned: a tiny in-repo recorder for Node and `probe <url>` to check a site from the browser.

## What is written to disk

| File | Contains | Safe to commit? |
|---|---|---|
| `api-dead-ends.config.json` | source type, service names, spec paths, env var **names** (never keys) | yes |
| `.api-dead-ends/NEXT-STEPS.md`, `AGENT.md` | commands and rules | yes |
| `.api-dead-ends/<service>/response.json` | the raw source response — **raw paths may contain tokens or IDs** | no; delete after `convert` |
| `usage.csv`, `report.md`, `report.json` | templated paths: numbers, UUIDs, hex, e-mails and token-like segments → `{id}`; query strings, `;params` and encoded `?` dropped. A plain lowercase word used as a secret (e.g. a reset code without digits) can still pass | review before sharing; internal paths |

`init` writes `.api-dead-ends/.gitignore`, which keeps everything except NEXT-STEPS.md and AGENT.md out of git.

## CI

```bash
api-dead-ends report --usage usage.csv --spec openapi.json --write-baseline baseline.json   # once
api-dead-ends report --usage usage.csv --spec openapi.json --baseline baseline.json --fail-on new-shadow,deprecated-growth
```

Exit codes: `0` ok · `1` check failed · `2` bad input. CI **never** fails on `not_seen`: removing an endpoint needs a human.

## Limits

- **Window.** Log retention is often 7–30 days. Monthly jobs, partners and old mobile clients may not show up. Confidence: `low` under 35 days, `medium` under 90, `high` from 90. APM metrics keep months — prefer them for "not seen".
- **Coverage.** Traffic that bypasses the logged layer, or endpoints that do not log, are invisible.
- **Double counting.** Some services log two records per failed request. Exclude the duplicate with `--exclude-filter` (Elasticsearch), or error shares will be inflated.
- **Path templating.** IDs are folded to `{id}` by rules (numbers, UUID, ULID, long hex, anything with digits ≥ 6 chars, e-mail-like); literal segments from your spec are kept.
- **Specs** must be JSON. Convert YAML first (for example `npx @redocly/cli bundle openapi.yaml --ext json -o openapi.json`).

## FAQ

### How do I find API endpoints that are not called?
Export request counts per method and path from your logs or APM for as long a window as you have (90 days is best), and run `report` against your OpenAPI spec. Endpoints with zero calls are listed as "not called" — check them with their owners before removing anything.

### OpenAPI vs real traffic: what's undocumented?
Everything in the "Undocumented" section: method + path pairs that real clients called but your spec does not describe. Debug and admin paths answering 2xx are flagged.

### Does it work without an OpenAPI spec?
Yes. Build one from your framework's route list with `spec from-routes` (Rails, Flask, Django, Spring, Gin, Echo, Laravel, Express…).

### Does it send my logs anywhere?
No. It reads aggregated counts locally and makes no network calls except `fetch elasticsearch` to your own cluster.

### What about shadow APIs and zombie APIs?
Shadow APIs are the "Undocumented" endpoints. Zombie APIs are usually "Deprecated but still called" or "Not called" endpoints that are still deployed.
