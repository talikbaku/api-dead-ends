// @ts-check
// Minimal MCP server over stdio (newline-delimited JSON-RPC). Zero dependencies.
// Dual-era: answers legacy `initialize` (2025-11-25 and earlier) and modern per-request `_meta` + `server/discover` (2026-07-28).
// Tools are read-only (only spec_from_routes with an explicit `out` writes a file inside the current directory). Nothing is sent over the network.
// stdout carries protocol messages only; diagnostics go to stderr.

import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from './setup/detect.mjs';
import { SOURCES, ROUTE_SOURCES, recommendSource, promPreset, buildSteps, safeName } from './setup/plan.mjs';
import { parseRoutes, routesToOpenApi } from './routes.mjs';
import { loadSpec, literalSegments } from './spec.mjs';
import { isIdSegment } from './template.mjs';
import { parseUsage, addRow } from './usage.mjs';
import { classify } from './classify.mjs';
import * as es from './adapters/elasticsearch.mjs';
import { datadog, appinsights, prometheus, loki, cloudwatch } from './adapters/others.mjs';
import { csv, splunk, datadogApm, newrelic, dynatrace, athena, bigquery, azureApim, accesslog } from './adapters/more.mjs';

const MODERN = ['2026-07-28'];
/** Values that end up inside printed shell commands. */
export const SAFE_ARG = /^[\w.:@\/*-]{1,200}$/;
// Until the package is on npm, plans must call this checkout directly.
const BIN = fileURLToPath(new URL('../bin/api-dead-ends.mjs', import.meta.url));
const CMD = /[\\/](_npx|node_modules)[\\/]/.test(BIN) ? 'npx api-dead-ends' : `node ${BIN}`;
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PV = 'io.modelcontextprotocol/protocolVersion';
const INFO = { name: 'api-dead-ends', version: '0.2.0' };
const INSTRUCTIONS = 'Find broken, unused and undocumented API endpoints from aggregated traffic. Start with detect_project, then setup_plan. '
  + 'Never treat "not seen" as proof that an endpoint is dead. Never pass raw logs or request bodies; work with usage tables and reports.';

/** @type {Record<string, { query: (o: any) => string, parse: (t: string, o?: any) => any[] }>} */
const ADAPTERS = {
  elasticsearch: { query: es.queryText, parse: es.parse }, opensearch: { query: es.queryText, parse: es.parse },
  datadog, 'datadog-apm': datadogApm, prometheus, loki, appinsights, 'azure-apim': azureApim, cloudwatch, athena, bigquery,
  newrelic, dynatrace, splunk, csv, accesslog,
};

const str = (d) => ({ type: 'string', description: d });
const TOOLS = [
  {
    name: 'detect_project',
    title: 'Scan a repository',
    description: 'Read-only scan of a repository: services, languages, frameworks, OpenAPI files, observability hints, and how to get a route list for each framework.',
    inputSchema: { type: 'object', properties: { path: str('Repository root (default: current directory)') } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'setup_plan',
    title: 'Plan the setup',
    description: 'Concrete commands per service for a traffic source (same as `init --yes --dry-run`). Writes nothing.',
    inputSchema: { type: 'object', properties: {
      path: str('Repository root'), source: { type: 'string', enum: SOURCES.map((s) => s.id) }, days: { type: 'number' },
      services: str('Comma-separated service names or dirs (default: all)'), index: str('Elasticsearch index pattern'),
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'build_query',
    title: 'Print a source query',
    description: 'Text of the aggregation query to run in the observability tool (the human runs it). Does not contact any system.',
    inputSchema: { type: 'object', required: ['source'], properties: {
      source: { type: 'string', enum: Object.keys(ADAPTERS) }, service: str('Service name in the source'), days: { type: 'number' },
      index: str('Elasticsearch index'), preset: str('Prometheus preset'), metric: str('Datadog APM metric'),
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'spec_from_routes',
    title: 'Spec from a route list',
    description: 'Build a minimal OpenAPI document from a framework route list file. With `out`, writes a NEW .json file inside the current directory (never overwrites)'+ '; otherwise returns it. Route list file (rails routes, flask routes, Spring actuator mappings, Gin debug, Laravel route:list, express-list-endpoints, "METHOD /path" lines).',
    inputSchema: { type: 'object', required: ['file'], properties: { file: str('Path to routes.txt or routes.json'), out: str('Optional: write the OpenAPI JSON to this path (inside the repo)'), title: str('Optional title, e.g. the service name') } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'analyze_usage',
    title: 'Analyze a usage table',
    description: 'Compare a usage table (CSV/JSON from `convert` or `fetch`) or a saved source response with the spec or a route list. Returns totals, server errors (with share), 5xx below threshold, client errors, undocumented and possibly-undocumented endpoints, not-seen endpoints.',
    inputSchema: { type: 'object', properties: {
      spec: str('OpenAPI/Swagger JSON path'), routes: str('Alternatively: a framework route list (routes.txt/json)'), usage: str('Usage table path (method,path,calls,…)'),
      response: str('Alternatively: a saved source response to convert first'), source: { type: 'string', enum: Object.keys(ADAPTERS) },
      days: { type: 'number' }, top: { type: 'number', description: 'Max items per list (default 20)' },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

/**
 * Every path an agent passes must stay inside the working directory, after resolving symlinks.
 * Prompt injection in tool results could otherwise make an agent read ~/.ssh or write anywhere.
 * @param {string} cwd @param {string} p
 */
async function inside(cwd, p) {
  if (typeof p !== 'string' || !p) throw new Error('path required');
  const root = await realpath(cwd);
  const abs = resolve(root, p);
  let real = abs;
  try { real = await realpath(abs); } catch { real = resolve(await realpath(dirname(abs)).catch(() => dirname(abs)), basename(abs)); }
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path must be inside the current directory');
  return real;
}
const MAX_INPUT = 200 * 1024 * 1024;
/** @param {string} cwd @param {string} p */
async function readInside(cwd, p) {
  const f = await inside(cwd, p);
  const st = await lstat(f);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > MAX_INPUT) throw new Error('file too large for MCP (use the CLI)');
  return readFile(f, 'utf8');
}

/** @param {string} name @param {any} a */
async function callTool(name, a = {}) {
  const cwd = process.cwd();
  if (name === 'detect_project') {
    const d = await detectProject(await inside(cwd, a.path || '.'));
    return { ...d, suggestedSource: recommendSource(d), routeSources: Object.fromEntries(d.services.flatMap((s) => s.frameworks).filter((f) => ROUTE_SOURCES[f]).map((f) => [f, ROUTE_SOURCES[f]])) };
  }
  if (name === 'setup_plan') {
    const d = await detectProject(await inside(cwd, a.path || '.'));
    const type = a.source || recommendSource(d);
    const src = SOURCES.find((s) => s.id === type);
    if (!src) throw new Error(`unknown source ${type}`);
    const want = a.services ? String(a.services).split(',').map((x) => x.trim()) : null;
    const svcs = (d.services.length ? d.services : [{ dir: '.', name: 'service', language: 'unknown', frameworks: [], loggers: [], observability: [], specs: d.specs }])
      .filter((s) => !want || want.includes(s.name) || want.includes(s.dir));
    const config = {
      version: /** @type {1} */ (1), source: { type, access: 'paste', index: a.index }, days: a.days || src.defaultDays, ai: { mode: /** @type {'off'} */ ('off') }, out: '.api-dead-ends', cmd: CMD,
      services: svcs.map((s) => ({ name: safeName(s.name), dir: s.dir, language: s.language, frameworks: s.frameworks, logName: s.name, spec: s.specs[0] || null, routes: s.specs[0] ? null : s.routeFiles?.[0] || null, ...(type === 'prometheus' ? { preset: promPreset(s) } : {}) })),
    };
    return { config, steps: buildSteps(config), verifiedSource: src.verified };
  }
  if (name === 'build_query') {
    const ad = Object.hasOwn(ADAPTERS, a.source) ? ADAPTERS[a.source] : null;
    if (!ad) throw new Error('unknown source');
    for (const k of ['service', 'index', 'preset', 'metric']) if (a[k] != null && !SAFE_ARG.test(String(a[k]))) throw new Error(`${k} may contain only letters, digits and . _ - : / * @`);
    return { query: ad.query({ service: a.service, days: a.days, index: a.index, preset: a.preset, metric: a.metric }) };
  }
  if (name === 'spec_from_routes') {
    const routes = parseRoutes(await readInside(cwd, a.file));
    const doc = routesToOpenApi(routes, { title: a.title });
    if (a.out) {
      if (!/\.json$/i.test(a.out)) throw new Error('out must end with .json');
      if (!routes.length) throw new Error('no routes recognised; nothing written');
      await mkdir(dirname(await inside(cwd, a.out)), { recursive: true });
      const out = await inside(cwd, a.out); // re-check after mkdir (symlinked parents)
      await writeFile(out, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' }).catch((e) => {
        throw new Error(e.code === 'EEXIST' ? 'out exists; choose a new file name (existing files are never overwritten)' : 'cannot write out');
      });
      return { routes: routes.length, written: a.out };
    }
    return { routes: routes.length, openapi: doc };
  }
  if (name === 'analyze_usage') {
    if (!a.spec && !a.routes) throw new Error('pass spec (OpenAPI JSON) or routes (route list file)');
    const spec = loadSpec(a.spec ? parseJson(await readInside(cwd, a.spec)) : routesToOpenApi(parseRoutes(await readInside(cwd, a.routes))));
    const keep = literalSegments(spec, isIdSegment);
    let rows;
    if (a.usage) rows = parseUsage(await readInside(cwd, a.usage), { keep });
    else if (a.response && Object.hasOwn(ADAPTERS, a.source)) {
      const acc = new Map();
      for (const r of ADAPTERS[a.source].parse(await readInside(cwd, a.response), {})) addRow(acc, r, { keep });
      rows = [...acc.values()];
    } else throw new Error('pass usage, or response + source');
    const r = classify(rows, spec, { days: a.days });
    const top = a.top || 20;
    const share = (/** @type {number} */ x, /** @type {number} */ y) => (y ? Math.round((x / y) * 10000) / 100 : 0);
    const ep = (/** @type {any} */ e) => ({ method: e.method, path: e.path, calls: e.calls, errors5xx: e.errors5xx, share5xxPct: share(e.errors5xx, e.calls), class: e.class, last_seen: e.last_seen });
    return {
      window: r.window, totals: r.totals, thresholds: r.thresholds,
      serverErrors: r.serverErrors.slice(0, top).map(ep),
      errorsBelowThreshold: r.errorsBelow.slice(0, top).map(ep),
      clientErrors: r.clientErrors.slice(0, top).map((e) => ({ method: e.method, path: e.path, calls: e.calls, errors4xx: e.errors4xx, share4xxPct: share(e.errors4xx, e.calls), status: Object.fromEntries(e.status) })),
      possiblyUndocumented: r.ambiguous.slice(0, top),
      shadow: r.shadow.slice(0, top).map((e) => ({ method: e.method, path: e.path, calls: e.calls, kind: e.kind })),
      notSeen: r.endpoints.filter((e) => e.class === 'not_seen').slice(0, top).map((e) => ({ ...ep(e), periodicHint: e.periodicHint })),
      deprecatedInUse: r.endpoints.filter((e) => e.class === 'deprecated_in_use').slice(0, top).map(ep),
      note: 'not_seen means no calls in this window: it may be rare or not logged. Recommend, never delete automatically.',
    };
  }
  throw new Error(`unknown tool ${name}`);
}

/** JSON.parse without echoing file content back. @param {string} t */
function parseJson(t) {
  try { return JSON.parse(t); } catch { throw new Error('spec is not valid JSON'); }
}

/** Error text for the agent, without file contents (CSV headers, JSON snippets). @param {unknown} e */
function safeError(e) {
  return String(/** @type {Error} */ (e)?.message || e).split('\n')[0]
    .replace(/\((have|found|got)[^)]*\)/gi, '').replace(/"[^"]{0,200}"\.\.\./g, '').replace(/Unexpected token.*$/, 'invalid JSON').slice(0, 200);
}

/**
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, log?: (s: string) => void }} [io]
 */
export function serve(io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const log = io.log || ((s) => process.stderr.write(`[api-dead-ends mcp] ${s}\n`));
  const send = (/** @type {any} */ m) => output.write(JSON.stringify(m) + '\n');
  const rl = createInterface({ input, terminal: false });
  let pending = 0;
  let ended = false;
  const done = new Promise((res) => {
    const maybe = () => { if (ended && pending === 0) res(undefined); };
    rl.on('close', () => { ended = true; maybe(); });
    // One message at a time, in order: an agent may send spec_from_routes and analyze_usage back to back.
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      pending++;
      chain = chain.then(() => handle(line)).catch(() => {}).finally(() => { pending--; maybe(); });
    });
  });

  /** @param {string} line */
  async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const { id, method, params = {} } = msg;
    const isReq = id !== undefined && id !== null;
    const reply = (/** @type {any} */ result) => isReq && send({ jsonrpc: '2.0', id, result });
    const error = (/** @type {number} */ code, /** @type {string} */ message, /** @type {any} */ data) => isReq && send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
    if (!method) return; // a response from the client — we never send requests
    const requested = params?._meta?.[PV];
    if (requested && !MODERN.includes(requested) && !LEGACY.includes(requested)) {
      return error(-32022, 'Unsupported protocol version', { supported: [...MODERN, ...LEGACY], requested });
    }
    try {
      switch (method) {
        case 'initialize': {
          const v = LEGACY.includes(params.protocolVersion) ? params.protocolVersion : LEGACY[0];
          return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: INFO, instructions: INSTRUCTIONS });
        }
        case 'server/discover':
          return reply({ resultType: 'complete', supportedVersions: [...MODERN], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': INFO }, instructions: INSTRUCTIONS });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ resultType: 'complete', tools: TOOLS });
        case 'tools/call': {
          if (!TOOLS.find((t) => t.name === params.name)) return error(-32602, `Unknown tool: ${params.name}`);
          try {
            const data = await callTool(params.name, params.arguments || {});
            return reply({ resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false });
          } catch (e) {
            return reply({ resultType: 'complete', content: [{ type: 'text', text: `Error: ${safeError(e)}` }], isError: true });
          }
        }
        default:
          if (method.startsWith('notifications/')) return;
          return error(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      log(String(/** @type {Error} */ (e).message));
      return error(-32603, 'Internal error');
    }
  }
  return done;
}
