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
   - the OpenAPI file (JSON or YAML) for each service, or a route list file if there is no spec;
   - the window in days;
   - whether to write instructions for your AI assistant.
3. **Writes** `api-dead-ends.config.json` and `.api-dead-ends/NEXT-STEPS.md` with the exact commands for every service. It never changes your code and never overwrites files without `--force`.

Then follow `NEXT-STEPS.md`. For most sources it is three commands: print the query → run it in your tool and save the response → `convert` and `report`.

`init --help` lists all flags. For Elasticsearch there are three ways: `--access kibana` — a browser opens, you log in to Kibana and the export runs through your session (needs Playwright; the default when `init` asks); `--access api-key` — pulls directly with a read-only key in `ES_API_KEY`; `--access paste` — the tool prints a query, you run it in Kibana Dev Tools and save the response (the default with `--yes` and no `--url`). Without a terminal, `init` refuses to guess: pipe answers (one per line) or add `--yes`.

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
- `probe <url>` checks the front end from a browser today, with no logs at all. Planned: a tiny in-repo recorder for Node.

## Logging coverage: which endpoints write no logs

Three checks, from cheap to certain:

- `logging-check [dir]` — static: finds explicit "do not log" settings in code and config (nginx `access_log off`, morgan `skip`, pino-http `ignore`, Next.js `matcher`…).
- `coverage --usage app.csv --reference ingress.csv` — compares two sources you already have: endpoints the ingress / APM sees but the app logs miss or under-count.
- `logging-probe` — active, **staging only**. Works with any log source, in two steps:

```bash
api-dead-ends logging-probe send --url https://staging.example.com --spec openapi.json --dry-run   # look at the plan first
api-dead-ends logging-probe send --url https://staging.example.com --spec openapi.json --header 'Authorization: $STAGING_TOKEN'
# → probe-run-<run>.json; export the app's logs for the printed time window (Kibana, VictoriaLogs, Loki, CloudWatch, plain files…), then:
api-dead-ends logging-probe verify --run probe-run-<run>.json --logs export.jsonl [--logs more files…] -o out/
```

`send` makes one GET/HEAD request per spec operation (path parameters become `ade-probe`), 2 per second by default, each tagged with a unique marker `ade-<run>-NNNN` in the `X-ADE-Probe` header, the User-Agent and the query (`?ade_probe=`) — access logs usually record at least one of these. The path between `--url` and the spec paths comes from the spec (`servers[0].url` with the server variables' defaults, or Swagger `basePath`), left out when the `--url` path already contains it; `--base-path P` replaces it (`''` = none). Every request URL must stay on the `--url` host; anything else is not sent. Redirects are not followed and response bodies are never read; the run manifest (`probe-run-<run>.json` in the current folder unless you pass `-o`; `-o -` = stdout) keeps only operation → marker, status and latency. `--header 'Name: value'` (repeatable) adds e.g. auth; `'Name: $ENV_VAR'` takes the value from the environment so it stays out of shell history. Header values are never written to the manifest or printed. `--dry-run` prints the plan (requests, URLs, operations not sent) and sends and writes nothing. If no request reaches the target, `send` says so and exits 1. Otherwise it prints search queries for common sources (KQL, LogsQL, LogQL, CloudWatch, Datadog, grep), each with a placeholder for your service.

Export only the logs of the application you want to check. Ingress, nginx, gateway and load balancer access logs record every request, so mixed into the export they make everything look logged; `verify` warns when a file name looks like one and shows in which file each marker was found.

`verify` streams the export (`.gz` and `-` for stdin are fine; single-line JSON exports too; `--logs` can be repeated) and reports per operation:

- **logged** — a log record has its marker (the "Found in" column says which file);
- **NOT logged** — the request got a response, no log record has its marker;
- **answered by gateway/auth (handler maybe not reached)** — the response was 401/403/404 or a redirect and no marker was found: a gateway, auth layer or router probably answered before the handler. Pass credentials with `--header` and send again;
- **not reached** — the request failed;
- **unknown (check the export)** — no marker of the run was found anywhere, so the export is probably wrong (other source or window, logs not shipped yet). `verify` exits 1.

`-o` for `verify`: `FILE.md` → Markdown, `FILE.json` → JSON, anything else is a folder with `logging-probe.md` and `logging-probe.json`. Without `-o` the Markdown goes to stdout (`--json`: JSON).

Why an endpoint is missing: the route is registered before the logging middleware or in a separate router/app, a skip/ignore rule (run `logging-check`), sampling, a gateway answering 401/403/404/3xx before the app, or filters in the log shipper.

Never point `send` at production. If the host name does not look like staging (`stag*`, `stg`, `test`, `dev`, `qa`, `uat`, `sandbox`, `local`, localhost, private IPs; a name with `prod` in any part never counts), `send` refuses unless you add `--target-is-staging`, or asks you to confirm when it runs in a terminal. `--include-writes --i-understand-this-is-staging` (both required) also sends POST/PUT/PATCH/DELETE as a deliberately invalid request (`Content-Type: application/json`, body `{}`); on a host that does not look like staging this is always refused. Endpoints that need no body — `POST …/cancel`, `POST /internal/sync`, a `DELETE` — can really run, so use it only on disposable staging data. `send` and `verify` refuse flags they do not use. `logging-probe` is CLI only; the MCP server has no tool that sends requests. (`logging-check send` is an error that points here.)

## What is written to disk

| File | Contains | Safe to commit? |
|---|---|---|
| `api-dead-ends.config.json` | source type, service names, spec paths, env var **names** (never keys) | yes |
| `.api-dead-ends/NEXT-STEPS.md`, `AGENT.md` | commands and rules | yes |
| `.api-dead-ends/<service>/response.json` | the raw source response — **raw paths may contain tokens or IDs** | no; delete after `convert` |
| `usage.csv`, `report.md`, `report.json` | templated paths: numbers, UUIDs, hex, e-mails and token-like segments → `{id}`; query strings, `;params` and encoded `?` dropped. A plain lowercase word used as a secret (e.g. a reset code without digits) can still pass | review before sharing; internal paths |
| `probe-run-<run>.json`, `logging-probe.md/.json` (`logging-probe`) | run id, target base URL, spec paths, marker per operation, status code, latency, names of `--header` headers (never values), file names of the log exports; no response bodies, no log lines | yes, if the staging URL is not secret |

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
- **Specs** can be JSON or YAML (any file extension; JSON is tried first). The built-in YAML reader covers what OpenAPI files use (block and flow collections, quoted and block scalars, anchors/aliases and `<<` merges with an expansion cap, explicit `? key` entries with a scalar key, the core tags `!!str` `!!int` `!!float` `!!bool` `!!null`); it refuses custom tags, collections used as keys, duplicate keys and a `__proto__` key.

## FAQ

### How do I find API endpoints that are not called?
Export request counts per method and path from your logs or APM for as long a window as you have (90 days is best), and run `report` against your OpenAPI spec. Endpoints with zero calls are listed as "not called" — check them with their owners before removing anything.

### OpenAPI vs real traffic: what's undocumented?
Everything in the "Undocumented" section: method + path pairs that real clients called but your spec does not describe. Debug and admin paths answering 2xx are flagged.

### Does it work without an OpenAPI spec?
Yes. Build one from your framework's route list with `spec from-routes` (Rails, Flask, Django, Spring, Gin, Echo, Laravel, Express…).

### Does it send my logs anywhere?
No. It reads aggregated counts locally. The only network access is what you start yourself: `fetch elasticsearch` / `fetch kibana` / `fetch victorialogs` to your own cluster, `probe <url>` to the site you name, and `logging-probe send --url` to the staging URL you name (marked test requests, GET/HEAD only unless you add two explicit flags; your logs are read locally by `logging-probe verify`).

### What about shadow APIs and zombie APIs?
Shadow APIs are the "Undocumented" endpoints. Zombie APIs are usually "Deprecated but still called" or "Not called" endpoints that are still deployed.

## Next.js on Vercel (no logs)

Vercel keeps runtime logs for a short time (about 1 hour on Hobby, 1 day on Pro), so there is no long history to analyse. What works today:

1. **Routes:** `npx api-dead-ends spec from-next . -o openapi.json` — from `app/**/route.*` and `pages/api`.
2. **Front end:** `npx api-dead-ends probe https://your-app.vercel.app --spec openapi.json` — duplicate, broken and slow API calls per page, and which routes the pages call. Use `--login` for pages behind a login.
3. **Traffic over time:** send logs somewhere that keeps them — a log drain (Pro) or OpenTelemetry (`@vercel/otel`) to Datadog, Grafana/Loki or Elastic — then pick that source in `init`. Any export with method, path, status and a timestamp also works: `convert csv export.csv --map method=…,path=…,status=…,day=… --daily`.

## Windows, spikes and the HTML report

With `--daily`, `convert` and `fetch` keep one row per day. `report` then computes the whole period and the last 7, 3 and 1 days, lists **recent spikes** (an endpoint over the 5xx threshold in a short window but not over the whole period) and writes `report.html` with a window switcher. Without days, the report covers the whole export and `--days` sets its length.
