#!/usr/bin/env node
// @ts-check
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseUsage, addRow, toCsv } from '../src/usage.mjs';
import { loadSpec, literalSegments } from '../src/spec.mjs';
import { isIdSegment } from '../src/template.mjs';
import { classify } from '../src/classify.mjs';
import { runInit, UsageError } from '../src/setup/wizard.mjs';
import { detectProject } from '../src/setup/detect.mjs';
import { parseRoutes, routesToOpenApi } from '../src/routes.mjs';
import { toMarkdown, toJson, toTerminal } from '../src/report.mjs';
import { toHtml } from '../src/html.mjs';
import { writeSafe } from '../src/safewrite.mjs';
import { computeWindows } from '../src/windows.mjs';
import { makeBaseline, compareBaseline } from '../src/baseline.mjs';
import * as es from '../src/adapters/elasticsearch.mjs';
import { datadog, appinsights, prometheus, loki, cloudwatch } from '../src/adapters/others.mjs';
import { csv, splunk, datadogApm, newrelic, dynatrace, athena, bigquery, azureApim, accesslog } from '../src/adapters/more.mjs';

const HELP = `api-dead-ends — find broken, unused and undocumented API endpoints from traffic you already have.

Start here:
  api-dead-ends init                 Step-by-step setup (api-dead-ends init --help): scans the repo, asks what you have, writes
                                     api-dead-ends.config.json and .api-dead-ends/NEXT-STEPS.md. Changes no code.
      --yes                          take defaults (non-interactive)   --dry-run   write nothing
      --json                         print the plan as JSON (for scripts and AI agents)
      --source S --services a,b --spec F --routes F --days N --index P --access kibana|api-key|paste --url U --ai off|prompt|mcp --force
  api-dead-ends detect [dir]         Print what the scan found (JSON).
  api-dead-ends spec from-routes <routes.txt|json> [-o openapi.json]   ·   spec from-next <dir>  (Next.js app/ and pages/api)
                                     No OpenAPI? Build one from your framework's route list (rails routes, flask routes,
                                     Spring /actuator/mappings, Gin debug, Laravel route:list --json, "METHOD /path" lines).
  api-dead-ends probe <url> [--pages 20] [--login] [--spec F] [--out dir]
                                     Open the site in a browser (needs Playwright) and find API calls sent several times
                                     per page, broken and slow calls. Navigation only, same origin, nothing saved.
  api-dead-ends coverage --usage app.csv --reference ingress.csv [--spec F]
                                     "Not logged": endpoints seen by the ingress / load balancer / APM but missing from app logs.
  api-dead-ends logging-check [dir]  Static check: places in code/config that switch request logging off
                                     (nginx, ingress, morgan, pino-http, fastify, gin, echo, uvicorn, lograge, Next.js…).
  api-dead-ends mcp                  Run as an MCP server (stdio) for Claude Code, Cursor, VS Code…
  api-dead-ends utcp                 Print a UTCP manual so UTCP clients can call this CLI directly.

Commands:
  api-dead-ends query <source>  [--service X] [--days 15] [--index P] [--response FILE] [field flags]
      Print the query to run yourself. Sources:
        elasticsearch, opensearch   Kibana Dev Tools / OpenSearch Dashboards (tested on real data)
        datadog                     Logs or Spans aggregate API (~15 days)
        datadog-apm                 APM trace metrics, months of history (best for "not seen")
        prometheus                  PromQL, presets via --preset: otel, otel-old, spanmetrics, spring,
                                    prometheus-net, go-promhttp, express, fastapi, nginx-ingress, traefik
        loki                        LogQL over JSON logs
        appinsights, azure-apim     Azure Application Insights / API Management (KQL)
        cloudwatch, athena          AWS: Logs Insights, ALB logs in Athena
        bigquery                    GCP load balancer logs
        newrelic, dynatrace         NRQL / DQL
        splunk, csv                 any table export (--map method=..,path=..,calls=..,status=..)
        accesslog                   raw nginx/Apache/JSON access logs on disk (.gz ok), streamed locally
  api-dead-ends convert <source> <response-file...> [field flags] [--daily] [-o usage.csv]
      accesslog only: --duplicates dup.json [--dup-window 2]  repeated POST/PUT/PATCH/DELETE from the same client
      Turn the saved response into a usage table (method,path,calls,first_seen,last_seen,status).
  api-dead-ends fetch elasticsearch --url <es-url> --index <pattern> [--service X] [--days 15] [-o usage.csv]
  api-dead-ends fetch kibana --url "<Kibana Discover URL>" --service X [--days 15]   (browser login, needs Playwright)
      Pull the usage table straight from Elasticsearch/OpenSearch (API key in ES_API_KEY). Read-only, 3-hour windows.
  api-dead-ends report --usage <usage.csv|json> --spec <openapi.json> [options]
      --days N            window length (default: inferred from first/last seen)
      --rare N            fewer calls than this = rare (default 100)
      --out DIR           write report.md + report.json there (default: print Markdown)
      --json              print report.json to stdout instead of Markdown
      --probe FILE        add a probe.json (from \`probe --out\`) to report.html
      --duplicates FILE   add duplicates.json (from \`convert accesslog … --duplicates FILE\`) to the report
      --baseline FILE     compare shadow endpoints with a saved baseline (CI mode)
      --fail-on LIST      new-shadow (default), deprecated-growth
      --write-baseline F  save current shadow list as a baseline
      --keep-preflight    do not hide OPTIONS/HEAD as noise
      --error-min N       server-error finding needs at least N 5xx responses (default 10)
      --error-share P     … and at least P% of calls (default 1)

Pass --spec to query/convert/fetch too: literal spec segments (oauth2, 2024, …) are then never folded into {id}.
Field flags: --method-field --path-field --status-field --service-field --time-field --metric --preset --map
             --exclude-filter 'message.keyword:"<duplicate message>"' (Elasticsearch: drop records that duplicate a request)
             --access-filter  'message.keyword:"Request"' (keep only access records — check first that every request has one)
Exit codes: 0 ok · 1 CI check failed · 2 bad input. Never fails on "not seen" — that needs a human.`;

let parsed;
try {
  parsed = parseArgs({
  allowPositionals: true,
  options: {
    usage: { type: 'string' }, spec: { type: 'string' }, days: { type: 'string' }, rare: { type: 'string' },
    out: { type: 'string', short: 'o' }, baseline: { type: 'string' }, 'fail-on': { type: 'string' },
    'write-baseline': { type: 'string' }, 'keep-preflight': { type: 'boolean' },
    service: { type: 'string' }, index: { type: 'string' }, url: { type: 'string' },
    'method-field': { type: 'string' }, 'path-field': { type: 'string' }, 'status-field': { type: 'string' },
    'service-field': { type: 'string' }, 'time-field': { type: 'string' }, 'access-filter': { type: 'string' }, 'exclude-filter': { type: 'string' },
    metric: { type: 'string' }, preset: { type: 'string' }, map: { type: 'string' }, 'raw-path': { type: 'boolean' }, 'window-hours': { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' },
    source: { type: 'string' }, services: { type: 'string' }, routes: { type: 'string' }, access: { type: 'string' }, ai: { type: 'string' },
    files: { type: 'string' }, logs: { type: 'string' }, dir: { type: 'string' }, 'log-name': { type: 'string' },
    response: { type: 'string' }, daily: { type: 'boolean' }, html: { type: 'boolean' },
    duplicates: { type: 'string' }, reference: { type: 'string' }, 'dup-window': { type: 'string' },
    pages: { type: 'string' }, 'api-host': { type: 'string' }, login: { type: 'boolean' }, headed: { type: 'boolean' }, probe: { type: 'string' }, 'slow-ms': { type: 'string' }, 'error-min': { type: 'string' }, 'error-share': { type: 'string' }, title: { type: 'string' },
  },
  });
} catch (e) {
  console.error(`Error: ${String(/** @type {Error} */ (e).message).split('\n')[0]}\nRun "api-dead-ends --help" for the list of options.`);
  process.exit(2);
}
const { values: v, positionals: pos } = parsed;
const INIT_HELP = `api-dead-ends init — step-by-step setup. Scans the repo (read-only), asks a few questions, writes
api-dead-ends.config.json and .api-dead-ends/NEXT-STEPS.md. Never changes code, never overwrites without --force.

  --yes, -y             no questions: take defaults and the flags below
  --dry-run             show the plan, write nothing        --json   plan as JSON on stdout (text goes to stderr)
  --source S            ${'elasticsearch, datadog-apm, datadog, prometheus, loki, appinsights, cloudwatch, newrelic,'}
                        dynatrace, splunk, accesslog, csv, none
  --service / --services a,b   only these services (names, dirs or numbers from the scan)
  --spec F              OpenAPI JSON (one service)       --routes F   framework route list (one service)
  --logs F              access log files / CSV export (sources accesslog, csv)
  --access kibana|api-key|paste --url U --index P   Elasticsearch: browser login to Kibana (default when asked),
                        read-only API key, or paste a query by hand (default with --yes and no --url)
  --log-name N          service name in the source (one service)
  --days N              window          --ai off|prompt|mcp      --force   overwrite existing files

Without a terminal, pass answers on stdin (one per line) or use --yes.`;

const fields = {
  daily: v.daily,
  service: v.service, days: v.days ? Number(v.days) : undefined, index: v.index, metric: v.metric, preset: v.preset, map: v.map,
  methodField: v['method-field'], pathField: v['path-field'], statusField: v['status-field'],
  serviceField: v['service-field'], timeField: v['time-field'], accessFilter: v['access-filter'], excludeFilter: v['exclude-filter'], rawPath: v['raw-path'],
};
/** @type {Record<string, { query: (o: any) => string, parse: (t: string, o?: any) => any[] }>} */
const SOURCES = {
  elasticsearch: { query: es.queryText, parse: es.parse }, opensearch: { query: es.queryText, parse: es.parse },
  datadog, 'datadog-apm': datadogApm, prometheus, loki, appinsights, 'azure-apim': azureApim, cloudwatch, athena, bigquery,
  newrelic, dynatrace, splunk, csv, accesslog,
};

const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const cmd0 = pos[0];
if (Number(process.versions.node.split('.')[0]) < 22 && cmd0 !== 'mcp' && !v.json) process.stderr.write(`Note: Node ${process.versions.node} is end-of-life and misses recent security fixes; Node 22 or 24 is recommended.\n`);
if (v.version) { console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version); process.exit(0); }
const CMD_HELP = {
  query: `api-dead-ends query <source> [--service S] [--days N] [--index P] [--preset P] [--metric M] [--response FILE] [--spec F]
Prints the aggregation query to run in your tool (nothing is sent anywhere). Sources: elasticsearch, opensearch, datadog,
datadog-apm, prometheus, loki, appinsights, azure-apim, cloudwatch, athena, bigquery, newrelic, dynatrace, splunk, csv, accesslog.
  --preset   Prometheus label set: otel, otel-old, spanmetrics, spring, prometheus-net, go-promhttp, express, fastapi, nginx-ingress, traefik, generic
  --metric   Datadog APM metric, e.g. trace.http.request.hits (Go), trace.servlet.request.hits (Java), trace.express.request.hits (Node)
  --response where you will save the response; printed hints then use the same file name
Field overrides: --method-field --path-field --status-field --service-field --time-field --exclude-filter --access-filter`,
  convert: `api-dead-ends convert <source> <file...> [--spec F] [--daily] [-o usage.csv]
Turns saved responses into a usage table (method,path,calls,first_seen,last_seen,status[,day]).
  --spec       keep literal segments of your spec (v1beta1, oauth2…) instead of folding them into {id}
  --daily      one row per day → 30/7/3/1-day windows and recent spikes in the report
  --duplicates F [--dup-window 2]   accesslog only: repeated POST/PUT/PATCH/DELETE from the same client
  --preset / --map / field flags as for query`,
  fetch: `api-dead-ends fetch elasticsearch --url URL --index P [--service S] [--days N] [--spec F] [--daily] [-o usage.csv]
Pulls the usage table straight from Elasticsearch/OpenSearch with a read-only key in ES_API_KEY. 3-hour windows, split on timeout.
api-dead-ends fetch kibana --url "<Kibana Discover URL>" --service S [--days N] [--daily] [--spec F] [--exclude-filter Q] [-o usage.csv]
Only a browser login to Kibana? A browser opens, you log in, and the tool runs the same read-only aggregation through
Kibana's Dev Tools proxy with your session (needs Playwright). Nothing is saved to disk. Fields are detected per service.`,
  report: `api-dead-ends report --usage usage.csv --spec openapi.json [--days N] [--out DIR] [--json]
Writes report.md, report.json and report.html (with --out), or prints Markdown / JSON.
  --days N          window length when the data has no dates     --rare N         fewer calls = rare (default 100)
  --error-share P   server-error finding: 5xx ≥ P% (default 1)    --error-min N    … and ≥ N responses (default 10)
  --probe F         add probe.json                                 --duplicates F   add duplicates.json
  --baseline F --fail-on new-shadow,deprecated-growth   CI mode (exit 1)   --write-baseline F   save the current shadow list`,
  spec: `api-dead-ends spec from-routes <routes.txt|json> [--title T] [-o openapi.json]
api-dead-ends spec from-next <next.js dir> [--title T] [-o openapi.json]
Builds a minimal OpenAPI spec from your framework's route list (rails routes, flask routes, Spring /actuator/mappings,
Gin debug lines, Laravel route:list --json, express-list-endpoints, Django show_urls, "METHOD /path" lines) or Next.js route files.`,
  probe: `api-dead-ends probe <url> [--pages 20] [--login] [--headed] [--slow-ms 2000] [--spec F] [--api-host api.example.com] [--out DIR]
Opens the site in Chromium (needs Playwright: npm i -D playwright && npx playwright install chromium) and records the API calls
each page makes: the same request several times per page load, 4xx/5xx/network/CORS failures, slow calls, and — with --spec —
which documented endpoints the pages call. Navigation only (no clicks or forms), same origin, logout/delete-like links skipped.
  --login     opens a visible browser; log in, then press Enter in the terminal. The session is not saved.
  --api-host  your API lives on another host (api.example.com): count it for spec coverage too.`,
  coverage: `api-dead-ends coverage --usage app-logs.csv --reference ingress.csv [--spec F] [--out DIR] [--json]
"Not logged": endpoints the reference source (ingress, load balancer, APM) sees but the application logs miss or under-count.`,
  'logging-check': `api-dead-ends logging-check [dir] [--json]
Static scan for settings that switch request logging off (nginx access_log off, ingress enable-access-log, morgan skip,
pino-http ignore, fastify disableRequestLogging, gin SkipPaths, echo Skipper, uvicorn --no-access-log, lograge ignore,
Next.js middleware matcher, Spring excludePathPatterns, Serilog filters). Unknown frameworks are reported as unknown.`,
  detect: `api-dead-ends detect [dir]   Read-only scan: services, languages, frameworks, specs, route files, observability hints (JSON).`,
  mcp: `api-dead-ends mcp   Stdio MCP server. Read tools: detect_project, setup_plan, build_query, spec_from_routes, analyze_usage. Write tools: init, write_report.`,
  utcp: `api-dead-ends utcp   Prints a UTCP manual whose tools call this CLI directly.`,
};
if (v.help || !cmd0) {
  if (cmd0 === 'init') console.log(INIT_HELP); else if (cmd0 && CMD_HELP[cmd0]) console.log(CMD_HELP[cmd0]); else console.log(HELP);
  process.exitCode = cmd0 || v.help ? 0 : 2;
  await new Promise((r) => process.stdout.write('', r));
  process.exit(process.exitCode);
}
/** Exit only after stdout is flushed (pipes are async in Node). @param {number} code @returns {Promise<never>} */
const exitAfterFlush = (code) => new Promise(() => process.stdout.write('', () => process.exit(code)));
if (cmd0 === 'mcp') { const { serve } = await import('../src/mcp.mjs'); await serve(); await exitAfterFlush(0); }
if (cmd0 === 'init') {
  try {
    await exitAfterFlush(await runInit({ cwd: process.cwd(), flags: v, input: process.stdin, out: process.stdout, err: process.stderr }));
  } catch (e) {
    console.error(`Error: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  }
}
if (cmd0 === 'utcp') { const { utcpManual } = await import('../src/utcp.mjs'); console.log(JSON.stringify(utcpManual(), null, 2)); await exitAfterFlush(0); }
if (cmd0 === 'probe') {
  const { probe, probeToMarkdown } = await import('../src/probe.mjs');
  if (!pos[1]) { console.error('Usage: api-dead-ends probe <url> [--pages 20] [--login] [--spec openapi.json] [--out dir]'); process.exit(2); }
  let pspec = null;
  try { pspec = v.spec ? loadSpec(JSON.parse(await readFile(v.spec, 'utf8'))) : null; } catch (e) { console.error(`Error: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`); process.exit(2); }
  const { createInterface } = await import('node:readline');
  const waitForEnter = () => new Promise((res) => { const rl = createInterface({ input: process.stdin }); rl.once('line', () => { rl.close(); res(undefined); }); });
  try {
    const p = await probe({ url: pos[1], apiHosts: v['api-host'] ? String(v['api-host']).split(',') : [], pages: v.pages ? Number(v.pages) : undefined, login: v.login, headed: v.headed, slowMs: v['slow-ms'] ? Number(v['slow-ms']) : undefined, spec: pspec, log: (s) => console.error(s), waitForEnter });
    const md = probeToMarkdown(p);
    if (v.out) {
      await mkdir(v.out, { recursive: true });
      await writeSafe(join(v.out, 'probe.json'), JSON.stringify(p, null, 2) + '\n');
      await writeSafe(join(v.out, 'probe.md'), md);
      const bad = p.rows.filter((r) => r.problem);
      console.error(`${p.pages} pages, ${p.requests} API requests, ${bad.length} problems → ${join(v.out, 'probe.md')} (add to the HTML report: report … --probe ${join(v.out, 'probe.json')})`);
    } else process.stdout.write(md);
  } catch (e) {
    console.error(`Error: ${String(/** @type {Error} */ (e).message).split('\n')[0].slice(0, 300)}`); // Playwright call logs can contain cookies
    process.exit(1);
  }
  await exitAfterFlush(0);
}
const readOr2 = async (/** @type {string} */ f) => { try { return await readFile(f, 'utf8'); } catch { console.error(`Error: cannot read ${f}`); process.exit(2); } };
if (cmd0 === 'coverage') {
  const { coverage, coverageToMarkdown } = await import('../src/coverage.mjs');
  if (!v.usage || !v.reference) { console.error('Usage: api-dead-ends coverage --usage app-logs.csv --reference ingress.csv [--spec openapi.json] [--out dir]\n  Which endpoints reach the reference source (ingress, load balancer, APM) but are missing from the application logs.'); process.exit(2); }
  let cspec = null;
  try { cspec = v.spec ? loadSpec(JSON.parse(await readFile(v.spec, 'utf8'))) : null; } catch (e) { console.error(`Error: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`); process.exit(2); }
  const ckeep = cspec ? literalSegments(cspec, isIdSegment) : new Set();
  const c = coverage(parseUsage(await readOr2(String(v.usage)), { keep: ckeep }), parseUsage(await readOr2(String(v.reference)), { keep: ckeep }), cspec);
  const md = coverageToMarkdown(c);
  if (v.json) process.stdout.write(JSON.stringify(c, null, 2) + '\n');
  else if (v.out) {
    await mkdir(v.out, { recursive: true });
    await writeSafe(join(v.out, 'coverage.md'), md);
    await writeSafe(join(v.out, 'coverage.json'), JSON.stringify(c, null, 2) + '\n');
    console.error(`not logged: ${c.notLogged.length}, under-logged: ${c.underLogged.length} → ${join(v.out, 'coverage.md')}`);
  } else process.stdout.write(md);
  await exitAfterFlush(0);
}
if (cmd0 === 'logging-check') {
  const { logCheck } = await import('../src/logcheck.mjs');
  const root = pos[1] || '.';
  const det = await detectProject(root);
  const r = await logCheck(root, { frameworks: det.services.flatMap((s) => s.frameworks) });
  if (v.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    console.log(r.findings.length ? 'Places where request logging is switched off:' : 'No explicit "do not log" settings found.');
    for (const f of r.findings) console.log(`  ${f.file}:${f.line}  [${f.framework}] ${f.what}\n      ${f.text}`);
    if (r.unknown.length) console.log(`No rules for: ${[...new Set(r.unknown)].join(', ')} — unknown, check manually or with an AI assistant.`);
    console.log(r.note);
  }
  await exitAfterFlush(0);
}
if (cmd0 === 'detect') { console.log(JSON.stringify(await detectProject(pos[1] || '.'), null, 2)); await exitAfterFlush(0); }
if (cmd0 === 'spec') {
  if (!['from-routes', 'from-next'].includes(pos[1]) || !pos[2]) { console.error('Usage: api-dead-ends spec from-routes <routes.txt|routes.json> [-o openapi.json]\n       api-dead-ends spec from-next <next.js project dir> [-o openapi.json]'); process.exit(2); }
  if (pos[1] === 'from-next' && !(await stat(pos[2]).then((x) => x.isDirectory()).catch(() => false))) { console.error(`Error: ${pos[2]} is not a directory`); process.exit(2); }
  const routes = pos[1] === 'from-next' ? await (await import('../src/routes.mjs')).scanNext(pos[2]) : parseRoutes(await readOr2(pos[2]));
  if (!routes.length) { console.error(pos[1] === 'from-next' ? 'No Next.js routes found (looked for app/**/route.* and pages/api/** under that folder).' : 'No routes recognised. Expected lines like "GET /users/:id" or a framework route dump.'); process.exit(2); }
  const doc = JSON.stringify(routesToOpenApi(routes, { title: v.title }), null, 2) + '\n';
  if (v.out) { await mkdir(join(v.out, '..'), { recursive: true }); await writeFile(v.out, doc); console.error(`${routes.length} routes → ${v.out}`); } else process.stdout.write(doc);
  await exitAfterFlush(0);
}

// Spec first: literal spec segments (oauth2, 2024…) are never folded into {id}.
let spec = null;
try {
  spec = v.spec ? loadSpec(JSON.parse(await readFile(v.spec, 'utf8'))) : null;
} catch (e) {
  console.error(`Error: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
  process.exit(2);
}
const keep = spec ? literalSegments(spec, isIdSegment) : new Set();
/** @type {any} */ (fields).keep = [...keep];

try {
  const cmd = pos[0];

  if (cmd === 'query') {
    // These values are pasted into shell commands the user will run: no quotes, $, ;, spaces…
    for (const k of ['service', 'index', 'preset', 'metric', 'response']) if (v[k] != null && !/^[\w.:@\/*-]{1,200}$/.test(String(v[k]))) fail(`--${k} may contain only letters, digits and . _ - : / * @`);
    const src = Object.hasOwn(SOURCES, pos[1]) ? SOURCES[pos[1]] : undefined;
    if (!src) fail(`Unknown source "${pos[1]}". Use: ${Object.keys(SOURCES).join(', ')}`);
    let text = src.query(fields);
    if (v.response) {
      // keep the file name in the printed instructions consistent with NEXT-STEPS.md
      text = text.replace(/> [\w.\/-]+\.json\b/g, `> ${v.response}`).replace(/(api-dead-ends convert \S+) [\w.\/<>-]+\.json\b/g, `$1 ${v.response}`);
      if (!/> /.test(text)) text += `\n# Save the response as: ${v.response}`;
    }
    console.log(text);
  } else if (cmd === 'convert') {
    const src = Object.hasOwn(SOURCES, pos[1]) ? SOURCES[pos[1]] : undefined;
    if (!src || !pos[2]) fail('Usage: api-dead-ends convert <source> <response-file> [-o usage.csv]');
    /** @type {Map<string, any>} */
    const acc = new Map();
    if (pos[1] === 'accesslog') {
      const st = await accesslog.stream(pos.slice(2), (r) => addRow(acc, r, { keep, daily: v.daily, dayFromTime: true }), v.duplicates ? { duplicates: { windowSec: v['dup-window'] ? Number(v['dup-window']) : 2, keep } } : {});
      console.error(`${st.lines} lines read, ${st.bad} not recognized`);
      if (st.duplicates) {
        await writeFile(v.duplicates, JSON.stringify(st.duplicates, null, 2) + '\n');
        console.error(`${st.duplicates.rows.length} endpoints with repeated non-GET requests → ${v.duplicates} (add to the report: report … --duplicates ${v.duplicates})`);
      }
    } else {
      for (const f of pos.slice(2)) for (const r of src.parse(await readFile(f, 'utf8'), fields)) addRow(acc, r, { keep, daily: v.daily });
    }
    const csv = toCsv([...acc.values()].sort((a, b) => b.calls - a.calls));
    if (v.out) { await writeFile(v.out, csv); console.error(`${acc.size} method+path pairs → ${v.out}`); } else process.stdout.write(csv);
    if (!spec && pos[1] !== 'csv') console.error('Note: no --spec given. Pass the same --spec as for `report`, so literal path segments from your spec (v1beta1, oauth2…) are not folded into {id}.');
    if (acc.size && [...acc.values()].every((r) => !r.first_seen)) console.error('Note: the response has no first/last seen dates. Pass --days N to `report` so it knows the window length.');
  } else if (cmd === 'fetch' && pos[1] === 'kibana') {
    if (!v.url || !v.service) fail('Usage: api-dead-ends fetch kibana --url "<Kibana Discover URL with the data view>" --service <name> [--days 15] [--daily] [--spec F] [-o usage.csv]');
    const { fetchKibana } = await import('../src/adapters/kibana.mjs');
    const { rows, skipped } = await fetchKibana({ ...fields, url: String(v.url), service: String(v.service), days: v.days ? Number(v.days) : 15, log: (m) => console.error(m) });
    /** @type {Map<string, any>} */
    const acc = new Map();
    for (const r of rows) addRow(acc, r, { keep, daily: v.daily });
    const csv = toCsv([...acc.values()].sort((a, b) => b.calls - a.calls));
    if (v.out) { await writeFile(v.out, csv); console.error(`${acc.size} rows → ${v.out}`); } else process.stdout.write(csv);
    if (skipped.length) console.error(`WARNING: ${skipped.length} time windows skipped — usage table is incomplete.`);
  } else if (cmd === 'fetch') {
    if (pos[1] !== 'elasticsearch' || !v.url || !v.index) fail('Usage: api-dead-ends fetch elasticsearch --url <es-url> --index <pattern> [--service X]\n       api-dead-ends fetch kibana --url "<Kibana Discover URL>" --service X   (log in in the browser; needs Playwright)');
    const key = process.env.ES_API_KEY;
    const search = async (/** @type {any} */ body) => {
      const r = await fetch(`${String(v.url).replace(/\/$/, '')}/${encodeURIComponent(String(v.index))}/_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `ApiKey ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    const { rows, skipped } = await es.collect(search, { ...fields, windowHours: v['window-hours'] ? Number(v['window-hours']) : 3, onProgress: (m) => console.error(m) });
    /** @type {Map<string, any>} */
    const acc = new Map();
    for (const r of rows) addRow(acc, r, { keep, daily: v.daily });
    const csv = toCsv([...acc.values()].sort((a, b) => b.calls - a.calls));
    if (v.out) await writeFile(v.out, csv); else process.stdout.write(csv);
    if (skipped.length) console.error(`WARNING: ${skipped.length} time windows skipped — usage table is incomplete.`);
  } else if (cmd === 'report') {
    if (!v.usage || !spec) fail('Usage: api-dead-ends report --usage <usage.csv> --spec <openapi.json>\n  usage.csv comes from `convert` or `fetch` (traffic data). No spec? `api-dead-ends spec from-routes <routes.txt>`. Not sure where to start? `api-dead-ends init`.');
    const dailyRows = parseUsage(await readFile(v.usage, 'utf8'), { keep, daily: true });
    const hasDays = dailyRows.some((x) => x.day);
    const rows = hasDays ? [...dailyRows.reduce((acc, x) => addRow(acc, { ...x, day: undefined }, { template: false }), new Map()).values()] : dailyRows;
    if (!rows.reduce((a, x) => a + x.calls, 0)) fail(`No traffic in ${v.usage}: 0 requests. Every endpoint would look "not seen", which says nothing. Check the query, the service name and the window.`);
    const num = (/** @type {string} */ k, /** @type {number} */ min, /** @type {number} */ max) => {
      if (v[k] === undefined) return undefined;
      const x = Number(v[k]);
      if (!Number.isFinite(x) || x < min || x > max) fail(`--${k} must be a number between ${min} and ${max}`);
      return x;
    };
    const share = num('error-share', 0, 100); // always a percent: 1 = 1%, 0.5 = 0.5%
    const failOn = v['fail-on']?.split(',').map((x) => x.trim()).filter(Boolean);
    for (const x of failOn || []) if (!['new-shadow', 'deprecated-growth'].includes(x)) fail(`--fail-on: unknown check "${x}". Use: new-shadow, deprecated-growth`);
    const cOpt = { rare: num('rare', 1, 1e9), keepPreflight: v['keep-preflight'], errorMin: num('error-min', 1, 1e9), errorShare: share === undefined ? undefined : share / 100 };
    // With per-day data the window is what the data covers; --days only applies to tables without dates.
    const win = hasDays ? computeWindows(dailyRows, spec, cOpt) : null;
    if (win && v.days && Number(v.days) !== win.windows.all.window.days) console.error(`Note: the data covers ${win.windows.all.window.days} days; --days ${v.days} is ignored for per-day data.`);
    if (win?.droppedToday) console.error('Note: today is incomplete and left out of the windows.');
    const r = win ? win.windows.all : classify(rows, spec, { ...cOpt, days: num('days', 1, 3650) });
    const extra = { spikes: win?.spikes || [], toolVersion: VERSION,
      probe: v.probe ? JSON.parse(await readFile(v.probe, 'utf8')) : null,
      duplicates: v.duplicates ? JSON.parse(await readFile(v.duplicates, 'utf8')) : null };
    const md = toMarkdown(r, extra);
    if (v.json && !v.out) process.stdout.write(toJson(r, extra));
    else if (v.out) {
      await mkdir(v.out, { recursive: true });
      await writeSafe(join(v.out, 'report.md'), md);
      await writeSafe(join(v.out, 'report.json'), toJson(r, extra));
      if (v.html !== false) {
        await writeSafe(join(v.out, 'report.html'), toHtml(r, { ...extra, win }));
      }
      const t = r.totals;
      console.error(toTerminal(r, { color: process.stderr.isTTY && !process.env.NO_COLOR, spikes: extra.spikes }) + '\n');
      console.error(`${t.operations} operations: server errors ${t.serverErrors} (+${t.serverErrorsBelowThreshold} below threshold), undocumented ${t.shadow}${t.ambiguous ? ` (${t.ambiguous} a word on a parameter)` : ''}, not called ${t.not_seen}, rare ${t.rare}, deprecated in use ${t.deprecated_in_use}, used ${t.used} → ${join(v.out, 'report.md')} · report.html`);
    } else process.stdout.write(md);
    if (v['write-baseline']) await writeFile(v['write-baseline'], JSON.stringify(makeBaseline(r), null, 2) + '\n');
    if (v.baseline) {
      const cmp = compareBaseline(r, JSON.parse(await readFile(v.baseline, 'utf8')), { failOn });
      for (const s of cmp.newShadow) console.error(`NEW SHADOW: ${s.method} ${s.path} (${s.calls} calls)`);
      for (const e of cmp.depGrowth) console.error(`DEPRECATED GROWTH: ${e.method} ${e.path} (${e.calls} calls)`);
      if (cmp.fail) process.exitCode = 1;
    }
  } else fail(`Unknown command "${cmd}".\n\n${HELP}`);
} catch (e) {
  console.error(`Error: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
  process.exit(2);
}

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(msg);
  process.exit(2);
}
