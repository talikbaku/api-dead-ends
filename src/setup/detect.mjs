// @ts-check
// Scan a repository (read-only) and find services, languages, frameworks, specs and observability hints.
// Works per directory, so polyglot monorepos give one entry per service.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', 'out', '.next', '.nuxt', '.venv', 'venv', 'env',
  '__pycache__', '.idea', '.vscode', 'coverage', 'bin', 'obj', '.gradle', '.terraform', 'tmp', 'log', 'logs', '.api-dead-ends']);

/** Manifest file → language. */
const MANIFESTS = {
  'package.json': 'node', 'go.mod': 'go', 'pom.xml': 'java', 'build.gradle': 'java', 'build.gradle.kts': 'java',
  'requirements.txt': 'python', 'pyproject.toml': 'python', 'Pipfile': 'python', 'setup.py': 'python',
  'Gemfile': 'ruby', 'composer.json': 'php', 'Cargo.toml': 'rust', 'mix.exs': 'elixir',
};

/** Dependency marker (regex on manifest text) → framework id. Order matters inside a language. */
const FRAMEWORKS = {
  node: [['nestjs', /"@nestjs\/core"/], ['next', /"next"\s*:/], ['fastify', /"fastify"\s*:/], ['hono', /"hono"\s*:/],
    ['koa', /"koa"\s*:/], ['hapi', /"@hapi\/hapi"/], ['express', /"express"\s*:/]],
  go: [['gin', /gin-gonic\/gin/], ['echo', /labstack\/echo/], ['chi', /go-chi\/chi/], ['fiber', /gofiber\/fiber/], ['gorilla', /gorilla\/mux/]],
  java: [['spring', /spring-boot|org\.springframework/], ['quarkus', /io\.quarkus/], ['micronaut', /io\.micronaut/]],
  python: [['fastapi', /\bfastapi\b/i], ['django', /\bdjango\b/i], ['flask', /\bflask\b/i]],
  ruby: [['rails', /\brails\b/], ['sinatra', /\bsinatra\b/], ['grape', /\bgrape\b/]],
  php: [['laravel', /laravel\/framework/], ['symfony', /symfony\/framework-bundle/]],
  dotnet: [['aspnetcore', /Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/]],
  rust: [['axum', /\baxum\b/], ['actix', /actix-web/]],
  elixir: [['phoenix', /:phoenix\b/]],
};

/** Observability markers in manifests and infra files. */
const OBS = [
  ['datadog', /dd-trace|ddtrace|DataDog\/dd-trace|dd-java-agent|Datadog\.Trace|datadog-agent|\bdatadog\b/i],
  ['opentelemetry', /opentelemetry/i],
  ['prometheus', /prom-client|prometheus_client|client_golang|micrometer-registry-prometheus|prometheus-net|prometheus-fastapi|\bprometheus\b/i],
  ['elasticsearch', /elasticsearch|kibana|@elastic\/|logstash|filebeat|opensearch/i],
  ['loki', /\bloki\b|promtail|grafana\/alloy/i],
  ['appinsights', /applicationinsights|ApplicationInsights/],
  ['newrelic', /newrelic/i],
  ['sentry', /sentry/i],
  ['nginx', /nginx|ingress-nginx/i],
];

/** Logging libraries (for the planned static "Not logged" check). */
const LOGGERS = /pino-http|pino|morgan|winston|bunyan|logrus|zap|zerolog|slog|logback|log4j|serilog|structlog|loguru|lograge|monolog/gi;

const SPEC_RE = /^(openapi|swagger|api-docs|api)([.-][\w.-]*)?\.(json|ya?ml)$/i;
const INFRA_RE = /^(docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|values[\w.-]*\.ya?ml|.*ingress.*\.ya?ml|.*helm.*\.ya?ml|Dockerfile)$/i;

/**
 * @typedef {{ dir: string, name: string, language: string, frameworks: string[], loggers: string[], observability: string[], specs: string[], routeFiles?: string[] }} Service
 * @typedef {{ root: string, services: Service[], specs: string[], observability: string[], infra: string[] }} Detection
 */

/**
 * @param {string} root
 * @param {{ maxDepth?: number, maxFiles?: number }} [opt]
 * @returns {Promise<Detection>}
 */
export async function detectProject(root, opt = {}) {
  const maxDepth = opt.maxDepth ?? 5;
  let budget = opt.maxFiles ?? 20000;
  /** @type {Service[]} */
  const services = [];
  const specs = [];
  const infraObs = new Set();
  const infra = [];

  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    if (depth > maxDepth || budget <= 0) return;
    let entries;
    try { entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch { return; }
    budget -= entries.length;
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const rel = relative(root, dir) || '.';

    for (const f of files) {
      if (SPEC_RE.test(f) && !/package(-lock)?\.json/.test(f)) {
        const p = join(rel, f);
        if (await looksLikeSpec(join(dir, f))) specs.push(p);
      }
      if (INFRA_RE.test(f)) {
        infra.push(join(rel, f));
        const text = await readSmall(join(dir, f));
        for (const [id, re] of OBS) if (re.test(text)) infraObs.add(String(id));
      }
    }

    const manifests = files.filter((f) => f in MANIFESTS || /\.csproj$/.test(f));
    if (manifests.length) {
      const svc = await describeService(dir, rel, manifests);
      // The root package.json of a JS monorepo (workspaces, no framework) is not a service.
      if (svc && !(svc.language === 'node' && !svc.frameworks.length && rel === '.' && /"workspaces"/.test(await readSmall(join(dir, 'package.json'))))) services.push(svc);
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);

  for (const s of services) s.specs = specs.filter((p) => p === s.dir || p.startsWith(s.dir === '.' ? '' : s.dir + '/'));
  const observability = [...new Set([...infraObs, ...services.flatMap((s) => s.observability)])];
  return { root, services, specs, observability, infra };
}

/**
 * @param {string} dir @param {string} rel @param {string[]} manifests
 * @returns {Promise<Service | null>}
 */
async function describeService(dir, rel, manifests) {
  let language = '';
  let text = '';
  let name = '';
  for (const m of manifests) {
    const lang = /\.csproj$/.test(m) ? 'dotnet' : MANIFESTS[m];
    language ||= lang;
    const t = await readSmall(join(dir, m));
    text += '\n' + t;
    if (!name) name = nameFrom(m, t);
  }
  // Python projects often keep deps in several files.
  if (language === 'python') for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) if (!manifests.includes(f)) text += await readSmall(join(dir, f));
  const frameworks = (FRAMEWORKS[language] || []).filter(([, re]) => re.test(text)).map(([id]) => String(id));
  const observability = OBS.filter(([, re]) => re.test(text)).map(([id]) => String(id)).filter((id) => id !== 'nginx');
  const loggers = [...new Set((text.match(LOGGERS) || []).map((x) => x.toLowerCase()))];
  if (!frameworks.length && language === 'node' && !/"(dependencies|devDependencies)"/.test(text)) return null;
  const routeFiles = (await readdir(dir).catch(() => [])).filter((f) => /^routes?\.(txt|json)$/i.test(f)).map((f) => join(rel, f));
  return { dir: rel, name: name || basename(dir === '.' ? process.cwd() : dir), language, frameworks, loggers, observability, specs: [], routeFiles };
}

/** @param {string} manifest @param {string} t */
function nameFrom(manifest, t) {
  try {
    if (manifest === 'package.json') return String(JSON.parse(t).name || '').replace(/^@[^/]+\//, '');
  } catch { /* ignore */ }
  let m;
  if (manifest === 'go.mod' && (m = t.match(/^module\s+(\S+)/m))) return m[1].split('/').pop() || '';
  if (manifest === 'pom.xml' && (m = t.match(/<artifactId>([^<]+)<\/artifactId>/))) {
    // first artifactId may belong to <parent>; prefer the one after </parent>
    const after = t.split('</parent>')[1];
    const m2 = after && after.match(/<artifactId>([^<]+)<\/artifactId>/);
    return (m2 || m)[1];
  }
  if (manifest === 'pyproject.toml' && (m = t.match(/^name\s*=\s*"([^"]+)"/m))) return m[1];
  return '';
}

/** @param {string} file */
async function readSmall(file) {
  try {
    const s = await stat(file);
    if (s.size > 512 * 1024) return '';
    return await readFile(file, 'utf8');
  } catch { return ''; }
}

/** @param {string} file */
async function looksLikeSpec(file) {
  const t = (await readSmall(file)).slice(0, 4000);
  return /["']?(openapi|swagger)["']?\s*:/.test(t);
}
