// @ts-check
// What the setup wizard knows: traffic sources, how to get a route list per framework,
// and how to turn answers into concrete commands that exist today.

/**
 * @typedef {{ id: string, label: string, verified: boolean, history: string, defaultDays: number, access: string[], env?: string[], hint: string }} SourceInfo
 */

/** @type {SourceInfo[]} */
export const SOURCES = [
  { id: 'elasticsearch', label: 'Elasticsearch / Kibana / OpenSearch', verified: true, history: 'log retention (often 7–30 days)', defaultDays: 15, access: ['api-key', 'paste'], env: ['ES_API_KEY'], hint: 'logs with method, path and status fields' },
  { id: 'datadog-apm', label: 'Datadog APM (trace metrics)', verified: false, history: '~15 months', defaultDays: 90, access: ['paste'], env: ['DD_API_KEY', 'DD_APP_KEY'], hint: 'best for "not called": months of history' },
  { id: 'datadog', label: 'Datadog Logs / Spans', verified: false, history: '~15 days', defaultDays: 15, access: ['paste'], env: ['DD_API_KEY', 'DD_APP_KEY'], hint: 'exact paths' },
  { id: 'prometheus', label: 'Prometheus / Thanos / Mimir / VictoriaMetrics', verified: false, history: '15 days (Prometheus) to months (long-term stores)', defaultDays: 30, access: ['paste'], hint: 'HTTP metrics with method/route/status labels' },
  { id: 'loki', label: 'Grafana Loki', verified: false, history: 'log retention', defaultDays: 15, access: ['paste'], hint: 'JSON access logs' },
  { id: 'appinsights', label: 'Azure Application Insights', verified: false, history: '90 days', defaultDays: 90, access: ['paste'], hint: 'requests table' },
  { id: 'cloudwatch', label: 'AWS CloudWatch Logs Insights', verified: false, history: 'as configured', defaultDays: 15, access: ['paste'], hint: 'access logs' },
  { id: 'newrelic', label: 'New Relic', verified: false, history: '8 days (events) / 13 months (metrics)', defaultDays: 8, access: ['paste'], hint: 'Transaction events' },
  { id: 'dynatrace', label: 'Dynatrace Grail', verified: false, history: 'per bucket', defaultDays: 30, access: ['paste'], hint: 'spans' },
  { id: 'splunk', label: 'Splunk', verified: false, history: 'as configured', defaultDays: 30, access: ['paste'], hint: 'CSV/JSON export of a stats search' },
  { id: 'accesslog', label: 'Access log files (nginx / Apache / JSON, .gz ok)', verified: false, history: 'whatever files you have', defaultDays: 15, access: ['files'], hint: 'files on disk' },
  { id: 'csv', label: 'Any CSV export (method, path, calls[, status])', verified: false, history: 'any', defaultDays: 30, access: ['files'], hint: 'map columns with --map' },
  { id: 'none', label: 'Nothing yet — no logs, no APM', verified: false, history: '—', defaultDays: 30, access: [], hint: 'see the options printed below' },
];

/** Prometheus preset by framework / library. */
const PROM_PRESET = { spring: 'spring', express: 'express', fastapi: 'fastapi', aspnetcore: 'prometheus-net', gin: 'go-promhttp', echo: 'go-promhttp', chi: 'go-promhttp', gorilla: 'go-promhttp', fiber: 'go-promhttp' };

/**
 * How to get a route list or a spec straight from the framework (no code parsing).
 * `spec` = produces OpenAPI JSON; `routes` = route list for `spec from-routes`.
 * @type {Record<string, { kind: 'spec'|'routes'|'planned', how: string }>}
 */
export const ROUTE_SOURCES = {
  spring: { kind: 'spec', how: 'springdoc: curl -s localhost:8080/v3/api-docs > openapi.json   (or: curl -s localhost:8080/actuator/mappings > routes.json)' },
  quarkus: { kind: 'spec', how: 'curl -s "localhost:8080/q/openapi?format=json" > openapi.json' },
  micronaut: { kind: 'spec', how: 'build with micronaut-openapi, then take the generated swagger file (convert YAML to JSON)' },
  fastapi: { kind: 'spec', how: 'curl -s localhost:8000/openapi.json > openapi.json' },
  django: { kind: 'routes', how: 'python manage.py show_urls > routes.txt   (django-extensions; with drf-spectacular: python manage.py spectacular --format openapi-json > openapi.json)' },
  flask: { kind: 'routes', how: 'flask routes > routes.txt' },
  rails: { kind: 'routes', how: 'bin/rails routes > routes.txt' },
  sinatra: { kind: 'routes', how: 'list routes as "GET /path" lines in routes.txt' },
  grape: { kind: 'routes', how: 'print API.routes as "METHOD /path" lines into routes.txt' },
  laravel: { kind: 'routes', how: 'php artisan route:list --json > routes.json' },
  symfony: { kind: 'routes', how: 'php bin/console debug:router > routes.txt' },
  gin: { kind: 'routes', how: 'start the app with GIN_MODE=debug and save the "[GIN-debug] GET /x --> …" lines to routes.txt' },
  echo: { kind: 'routes', how: 'print json.Marshal(e.Routes()) once at startup → routes.json' },
  chi: { kind: 'routes', how: 'chi.Walk(r, func(m, route string, …) error { fmt.Println(m, route); return nil }) → routes.txt' },
  gorilla: { kind: 'routes', how: 'r.Walk(…) printing "METHOD path" → routes.txt' },
  fiber: { kind: 'routes', how: 'print json.Marshal(app.GetRoutes()) → routes.json' },
  express: { kind: 'routes', how: 'console.log(JSON.stringify(require("express-list-endpoints")(app))) → routes.json  (Express 4)' },
  nestjs: { kind: 'spec', how: 'with @nestjs/swagger: curl -s localhost:3000/api-json > openapi.json' },
  fastify: { kind: 'spec', how: 'with @fastify/swagger: curl -s localhost:3000/documentation/json > openapi.json' },
  hono: { kind: 'routes', how: 'console.log(JSON.stringify(app.routes)) → routes.json' },
  koa: { kind: 'routes', how: 'print router.stack as "METHOD path" lines → routes.txt' },
  next: { kind: 'planned', how: 'App Router scan of app/**/route.* is planned; for now list "METHOD /api/…" lines in routes.txt' },
  aspnetcore: { kind: 'spec', how: 'Swashbuckle: curl -s localhost:5000/swagger/v1/swagger.json > openapi.json' },
  axum: { kind: 'routes', how: 'list routes as "METHOD /path" lines in routes.txt' },
  actix: { kind: 'routes', how: 'list routes as "METHOD /path" lines in routes.txt' },
  phoenix: { kind: 'routes', how: 'mix phx.routes > routes.txt' },
};

/**
 * Pick a default source from what the scan found.
 * @param {import('./detect.mjs').Detection} d
 */
export function recommendSource(d) {
  const o = new Set(d.observability);
  if (o.has('datadog')) return 'datadog-apm';
  if (o.has('elasticsearch')) return 'elasticsearch';
  if (o.has('prometheus')) return 'prometheus';
  if (o.has('loki')) return 'loki';
  if (o.has('appinsights')) return 'appinsights';
  if (o.has('newrelic')) return 'newrelic';
  if (o.has('nginx')) return 'accesslog';
  return 'elasticsearch';
}

/** @param {import('./detect.mjs').Service} s */
export function promPreset(s) {
  if (s.observability.includes('opentelemetry')) return 'otel';
  for (const f of s.frameworks) if (PROM_PRESET[f]) return PROM_PRESET[f];
  return 'generic';
}

/**
 * @typedef {{ name: string, dir: string, language: string, frameworks: string[], logName: string, spec: string | null, routes: string | null, preset?: string }} PlannedService
 * @typedef {{ version: 1, source: { type: string, access?: string, url?: string, index?: string, files?: string }, days: number, services: PlannedService[], ai: { mode: 'off'|'prompt'|'mcp' }, out: string, cmd?: string }} Config
 */

const q = (/** @type {string} */ s) => (/^[\w./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Service names come from repo manifests (untrusted): keep only safe characters for paths and shell commands. @param {string} s */
export function safeName(s) {
  return String(s).replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'service';
}

/**
 * Concrete commands per service. Every command here exists in this version.
 * @param {Config} c
 * @returns {Array<{ service: string, steps: Array<{ title: string, cmd?: string, note?: string }> }>}
 */
export function buildSteps(c) {
  const ade = c.cmd || 'npx api-dead-ends';
  return c.services.map((s0) => {
    const s = { ...s0, name: safeName(s0.name) };
    // c.out is set by our code (default .api-dead-ends); keep the leading dot so outputs stay under the git-ignored folder
    const dir = `${/^\.?[\w-]+$/.test(c.out) ? c.out : '.api-dead-ends'}/${s.name}`;
    const usage = `${dir}/usage.csv`;
    /** @type {Array<{ title: string, cmd?: string, note?: string }>} */
    const steps = [];
    let spec = s.spec;
    if (!spec && s.routes) {
      steps.push({ title: 'Build a spec from the route list', cmd: `${ade} spec from-routes ${q(s.routes)} --title ${q(s.name)} -o ${dir}/routes.openapi.json` });
      spec = `${dir}/routes.openapi.json`;
    }
    if (!spec) {
      const fw = s.frameworks.map((f) => ROUTE_SOURCES[f]).find(Boolean);
      const how = fw ? fw.how.replace(/> openapi\.json/g, `> ${dir}/openapi.json`) : '';
      const fromRoutes = `${ade} spec from-routes ${dir}/routes.txt --title ${q(s.name)} -o ${dir}/routes.openapi.json`;
      steps.push({ title: 'Get the list of endpoints', note: fw && fw.kind === 'spec'
        ? how
        : `${fw ? fw.how.replace(/routes\.(txt|json)/, `${dir}/routes.txt`) : `Export your OpenAPI JSON to ${dir}/openapi.json, or write ${dir}/routes.txt with "METHOD /path" lines`}\n  then: ${fromRoutes}` });
      spec = fw && fw.kind === 'spec' ? `${dir}/openapi.json` : `${dir}/routes.openapi.json`;
    }
    const specFlag = ` --spec ${q(spec)}`;
    const t = c.source.type;
    const days = ` --days ${c.days}`;
    const svc = ` --service ${q(s.logName)}`;
    if (t === 'elasticsearch') {
      if (c.source.access === 'api-key') {
        steps.push({ title: 'Pull the usage table from Elasticsearch (first: export ES_API_KEY=<read-only key> in your shell)', cmd: `${ade} fetch elasticsearch --url ${q(c.source.url || 'https://es.example:9200')} --index ${q(c.source.index || 'logs-*')}${svc}${days}${specFlag} --daily -o ${usage}` });
      } else {
        steps.push({ title: 'Print the query (skip if a colleague already gave you the response)', cmd: `${ade} query elasticsearch${svc}${days} --index ${q(c.source.index || 'logs-*')}${specFlag} --response ${dir}/response.json > ${dir}/query.txt` });
        steps.push({ title: 'Run it in Kibana → Dev Tools, save the response', note: `save the JSON response as ${dir}/response.json\n  already have an export? cp <your-file> ${dir}/response.json` });
        steps.push({ title: 'Convert the response', cmd: `${ade} convert elasticsearch ${dir}/response.json${specFlag} -o ${usage}` });
      }
    } else if (t === 'accesslog') {
      steps.push({ title: 'Read the access log files (streamed, IPs and user agents are dropped)', cmd: `${ade} convert accesslog ${c.source.files || '/var/log/nginx/access.log*'}${specFlag} --daily -o ${usage}` });
    } else if (t === 'csv') {
      steps.push({ title: 'Convert your CSV export', cmd: `${ade} convert csv ${c.source.files || 'export.csv'} --map method=…,path=…,calls=…,status=…${specFlag} -o ${usage}` });
    } else if (t === 'none') {
      const vercelish = s.frameworks.some((f) => ['next', 'hono'].includes(f));
      steps.push({ title: 'No traffic data yet — what you can do today', note: [
        'Without traffic there is no report: an empty table would mark every endpoint "not called", which says nothing.',
        vercelish
          ? '- Next.js / Vercel: runtime logs are kept for a short time (about 1 hour on Hobby, 1 day on Pro). If you export request logs (method, path, status) to CSV, run `convert csv <file> --map …`. With a log drain (Pro) or OpenTelemetry (`@vercel/otel`) to Datadog, Grafana or Elastic, pick that source and re-run init.'
          : '- Turn on access logs in your web server / ingress (nginx, Apache, ALB) and use the `accesslog` source.',
        '- If anything already collects traces or metrics (Datadog, Prometheus, OpenTelemetry, New Relic…), pick that source and re-run init.',
        '- Planned, not available yet: a tiny in-repo recorder and `probe <url>` (checks a site from the browser).',
      ].join('\n') });
      return { service: s.name, steps };
    } else {
      const preset = t === 'prometheus' ? ` --preset ${s.preset || 'generic'}` : '';
      steps.push({ title: `Print the ${t} query (skip if you already have the response)`, cmd: `${ade} query ${t}${svc}${days}${preset}${specFlag} --response ${dir}/response.json > ${dir}/query.txt` });
      steps.push({ title: 'Run the query from query.txt, save the response', note: `save it as ${dir}/response.json${(SOURCES.find((x) => x.id === t)?.env || []).length ? ` — needs ${SOURCES.find((x) => x.id === t)?.env?.join(', ')} in your shell, never in files` : ''}` });
      steps.push({ title: 'Convert the response', note: `already have an export? cp <your-file> ${dir}/response.json`, cmd: `${ade} convert ${t} ${dir}/response.json${preset}${specFlag}${['prometheus', 'datadog-apm'].includes(t) ? ' --daily' : ''} -o ${usage}` });
    }
    steps.push({ title: 'Build the report', cmd: `${ade} report --usage ${usage}${specFlag}${days} --out ${dir}/report` });
    return { service: s.name, steps };
  });
}

/** @param {Config} c */
export function renderNextSteps(c) {
  const src = SOURCES.find((s) => s.id === c.source.type);
  const L = ['# api-dead-ends — next steps', '',
    `Source: **${src?.label || c.source.type}**${src && !src.verified && c.source.type !== 'none' ? ' (built from vendor docs, not yet verified on a real account — tell us if parsing fails)' : ''}. Window: ${c.days} days.`,
    'Run the commands from the repository root. Nothing here changes your code.', ''];
  for (const s of buildSteps(c)) {
    L.push(`## ${s.service}`, '');
    s.steps.forEach((st, i) => {
      L.push(`${i + 1}. ${st.title}`);
      if (st.cmd) L.push('', '   ```bash', `   ${st.cmd}`, '   ```');
      if (st.note) L.push('', ...st.note.split('\n').map((x) => `   ${x}`));
      L.push('');
    });
  }
  L.push('## Reading the result', '',
    '- `report.html`: open in a browser — tabs per finding, 30/7/3/1-day windows when the usage table has days, recent spikes.\n- `report.md` / `report.json`: endpoints by class — used, rare, not seen, deprecated in use, shadow (in traffic, not in spec), noise, server errors.',
    '- "Not seen" is a hint, not a verdict: the endpoint may be called rarely, or its traffic may not be logged.',
    `- Window ${c.days} days: confidence ${c.days >= 90 ? 'high' : c.days >= 35 ? 'medium' : 'low — fine for errors, not for removal decisions'}.`,
    '- What is written to disk: `response.json` keeps the raw source response (raw paths may contain tokens or IDs); `usage.csv` and reports keep only templated paths. `.api-dead-ends/.gitignore` keeps everything except NEXT-STEPS.md and AGENT.md out of git. You can delete `response.json` after `convert`.', '');
  return L.join('\n');
}

/**
 * Instructions for an AI assistant working in this repository.
 * @param {Config} c
 */
export function renderAgentPrompt(c) {
  return `# api-dead-ends — instructions for AI assistants

You help this team find broken, unused and undocumented API endpoints with the \`api-dead-ends\` CLI.
Config: \`api-dead-ends.config.json\`. Steps: \`.api-dead-ends/NEXT-STEPS.md\`.

## What to do
1. Follow NEXT-STEPS.md for each service. Ask the human to run any query against production systems; you may run \`query\`, \`convert\`, \`spec from-routes\` and \`report\` locally.
2. Read \`report.json\` (not the raw responses) and summarise: server errors first, then shadow endpoints, then "not seen".
3. For a server-error endpoint, find the handler in the code and explain the likely cause. Propose a fix as a diff; do not apply it without the human's OK.

## Never
- Never delete or deprecate an endpoint because it was "not seen". It may be rare (monthly jobs, partners) or not logged. Recommend, with the window length and confidence.
- Never send raw logs, request bodies, tokens, IPs or customer data to any model or external service. Work from aggregated tables and report.json only.
- Never send non-GET requests to production. Never store API keys in files; use environment variables (${[...new Set(SOURCES.flatMap((s) => s.env || []))].join(', ')}).
- Never commit \`.api-dead-ends/\` outputs unless the human asks: they may contain internal paths.

## Commands
- \`${c.cmd || 'npx api-dead-ends'} --help\`
- \`${c.cmd || 'npx api-dead-ends'} spec from-routes <routes.txt|json> -o openapi.json\` — spec from a framework route list
- \`${c.cmd || 'npx api-dead-ends'} report --usage <usage.csv> --spec <openapi.json> --out <dir>\`
`;
}
