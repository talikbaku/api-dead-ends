// @ts-check
// `api-dead-ends init`: scan the repo, ask a few questions (Enter = default), write a config and next steps.
// Interactive by default; `--yes` takes defaults and flags, `--json` prints a machine-readable plan.
// Writes only into the repo: api-dead-ends.config.json and .api-dead-ends/. Never overwrites without --force.

import { createInterface } from 'node:readline';
import { writeFile, mkdir, readdir, rmdir, lstat } from 'node:fs/promises';
import { join, basename, resolve, relative } from 'node:path';
import { detectProject } from './detect.mjs';
import { SOURCES, recommendSource, promPreset, buildSteps, renderNextSteps, renderAgentPrompt, safeName } from './plan.mjs';

/**
 * @typedef {{ cwd: string, flags: Record<string, any>, input: NodeJS.ReadableStream, out: NodeJS.WritableStream, err: NodeJS.WritableStream }} InitIO
 */

/** @param {InitIO} io */
export async function runInit(io) {
  const f = { ...io.flags };
  if (f.service && !f.services) f.services = f.service; // --service is an alias
  if (f.logs && !f.files) f.files = f.logs;
  const root = resolve(io.cwd, f.dir || '.');
  const json = !!f.json;
  const say = (/** @type {string} */ s = '') => (json ? io.err : io.out).write(s + '\n');
  const auto = !!f.yes || json;
  const ask = auto ? async (/** @type {string} */ _q, /** @type {string} */ d) => d : asker(io.input, json ? io.err : io.out);
  const quiet = auto; // with --yes / --json: no menus, only the summary

  say('api-dead-ends init — finds broken, unused and undocumented API endpoints from traffic you already have.');
  say('Scanning the repository (read-only)…');
  const det = await detectProject(root);
  if (!det.services.length) det.services.push({ dir: '.', name: basename(root), language: 'unknown', frameworks: [], loggers: [], observability: [], specs: det.specs });
  say('');
  say(`Found ${det.services.length} service${det.services.length > 1 ? 's' : ''}:`);
  det.services.forEach((s, i) => say(`  ${i + 1}. ${s.name.padEnd(22)} ${s.dir.padEnd(24)} ${[s.language, ...s.frameworks].join(' · ')}${s.specs.length ? `  spec: ${s.specs[0]}` : ''}`));
  if (det.observability.length) say(`Observability hints: ${det.observability.join(', ')}`);
  say('');

  // 1. Source
  const one = f.services ? det.services.filter((s) => String(f.services).split(',').map((x) => x.trim()).includes(s.name) || String(f.services).split(',').includes(s.dir)) : det.services;
  // Suggest from the chosen services' own manifests; repo-wide hints (compose files) only when nothing more specific exists.
  const own = { ...det, observability: [...new Set(one.flatMap((s) => s.observability))] };
  const rec = f.source || (own.observability.length ? recommendSource(own) : one.length === det.services.length && det.observability.length ? recommendSource(det) : 'none');
  if (!SOURCES.find((s) => s.id === rec)) throw new UsageError(`Unknown --source "${rec}". Use: ${SOURCES.map((s) => s.id).join(', ')}`);
  if (!quiet) {
    say('Where can we read real API traffic? (the tool only reads aggregated counts: method, path, status)');
    SOURCES.forEach((s, i) => say(`  ${String(i + 1).padStart(2)}. ${s.label}${s.verified ? '  ✓ verified' : ''}${s.id === rec ? '  ← suggested' : ''}`));
  }
  const srcAns = await ask(`Source [${SOURCES.findIndex((s) => s.id === rec) + 1}]: `, String(SOURCES.findIndex((s) => s.id === rec) + 1));
  const src = pick(SOURCES, srcAns) || SOURCES.find((s) => s.id === rec);
  if (!src) throw new UsageError(`Unknown source "${srcAns}"`);

  /** @type {import('./plan.mjs').Config['source']} */
  const source = { type: src.id };
  if (src.id === 'elasticsearch') {
    // Non-interactive runs without a Kibana URL default to "paste" (a placeholder URL would open a browser for nothing).
    const accDef = f.access === 'api-key' ? '2' : f.access === 'kibana' ? '1' : f.access === 'paste' || (auto && !f.url) ? '3' : '1';
    const acc = await ask(`Access: 1) Kibana login in a browser (recommended, needs Playwright)  2) read-only API key  3) paste a query into Dev Tools by hand [${accDef}]: `, accDef);
    source.access = /^(2|api-key)$/.test(acc.trim()) ? 'api-key' : /^(3|paste)$/.test(acc.trim()) ? 'paste' : 'kibana';
    if (source.access === 'kibana') source.url = await ask(`Kibana Discover URL with your data view [${f.url || 'https://kibana.example/app/discover'}]: `, f.url || 'https://kibana.example/app/discover');
    else source.index = await ask(`Index pattern [${f.index || 'logs-*'}]: `, f.index || 'logs-*');
    if (source.access === 'api-key') source.url = await ask(`Elasticsearch URL [${f.url || 'https://localhost:9200'}]: `, f.url || 'https://localhost:9200');
  }
  if (src.id === 'accesslog' || src.id === 'csv') source.files = await ask(`File(s) or glob [${f.files || (src.id === 'csv' ? 'export.csv' : '/var/log/nginx/access.log*')}]: `, f.files || (src.id === 'csv' ? 'export.csv' : '/var/log/nginx/access.log*'));

  // 2. Services
  const wanted = f.services ? String(f.services).split(',').map((x) => x.trim()) : null;
  let chosen = det.services;
  if (wanted) chosen = det.services.filter((s, i) => wanted.includes(s.name) || wanted.includes(s.dir) || wanted.includes(String(i + 1)));
  else if (det.services.length > 1) {
    const a = await ask('Which services? numbers, comma-separated [all]: ', 'all');
    if (a.trim() && a.trim() !== 'all') chosen = a.split(',').map((x) => det.services[Number(x.trim()) - 1]).filter(Boolean);
  }
  if (!chosen.length) throw new UsageError('No services selected.');

  /** @type {import('./plan.mjs').PlannedService[]} */
  const services = [];
  for (const s of chosen) {
    if (!quiet) { say(''); say(`— ${s.name} (${s.dir}, ${[s.language, ...s.frameworks].join(' · ')})`); }
    const logName = src.id === 'none' || src.id === 'accesslog' || src.id === 'csv' ? s.name
      : await ask(`  Service name as it appears in ${src.label} [${chosen.length === 1 && f['log-name'] ? f['log-name'] : s.name}]: `, chosen.length === 1 && f['log-name'] ? f['log-name'] : s.name);
    const defSpec = (chosen.length === 1 && f.spec) || s.specs[0] || '';
    const spec = (await ask(`  OpenAPI/Swagger JSON file${defSpec ? ` [${defSpec}]` : ' (Enter to skip)'}: `, defSpec)).trim();
    let routes = '';
    const defRoutes = (chosen.length === 1 && f.routes) || s.routeFiles?.[0] || '';
    if (!spec) routes = (await ask(`  Route list file from the framework (routes.txt/json)${defRoutes ? ` [${defRoutes}]` : ', Enter to skip'}: `, defRoutes)).trim();
    if (spec && /\.ya?ml$/i.test(spec)) say('  ! YAML specs are not read yet — convert to JSON first (for example: npx @redocly/cli bundle spec.yaml --ext json -o openapi.json).');
    services.push({ name: safeName(s.name), dir: s.dir, language: s.language, frameworks: s.frameworks, logName, spec: spec || null, routes: routes || null, ...(src.id === 'prometheus' ? { preset: f.preset || promPreset(s) } : {}) });
  }

  // 3. Window and AI
  if (!quiet) say('');
  const days = src.id === 'none' ? src.defaultDays : Number(await ask(`Window in days [${f.days || src.defaultDays}]: `, String(f.days || src.defaultDays))) || src.defaultDays;
  const aiAns = await ask('AI assistants: 1) off  2) write an instructions file for your AI (Cursor, Claude Code…)  3) also print MCP config [1]: ', { off: '1', prompt: '2', mcp: '3' }[f.ai] || '1');
  const ai = /** @type {'off'|'prompt'|'mcp'} */ ({ 2: 'prompt', 3: 'mcp' }[aiAns.trim()] || 'off');

  /** @type {import('./plan.mjs').Config} */
  const config = { version: 1, source, days, services, ai: { mode: ai }, out: '.api-dead-ends', cmd: f.cmd || invocation(root) };
  const files = [
    ['api-dead-ends.config.json', JSON.stringify(config, null, 2) + '\n'],
    ['.api-dead-ends/NEXT-STEPS.md', renderNextSteps(config)],
    ['.api-dead-ends/.gitignore', '# outputs may contain internal paths — keep them out of git\n*\n!.gitignore\n!NEXT-STEPS.md\n!AGENT.md\n'],
  ];
  if (ai !== 'off') files.push(['.api-dead-ends/AGENT.md', renderAgentPrompt(config)]);

  say('');
  say('Summary');
  say(`  source:   ${src.label}${src.id === 'elasticsearch' ? ` (${source.access})` : ''}`);
  say(`  services: ${services.map((s) => s.name + (s.spec ? '' : s.routes ? ' (routes)' : ' (no spec yet)')).join(', ')}`);
  say(`  window:   ${days} days${days < 35 ? ' (short: fine for errors, low confidence for "not seen")' : ''}`);
  say(`  AI:       ${ai}`);
  say(`  files:    ${files.map(([p]) => p).join(', ')}`);

  if (f['dry-run']) {
    say('Dry run: nothing written.');
    if (json) io.out.write(JSON.stringify({ config, steps: buildSteps(config), files: files.map(([p]) => p) }, null, 2) + '\n');
    return 0;
  }
  const ok = await ask('Write these files? [Y/n]: ', 'y');
  if (/^n/i.test(ok.trim())) { say('Nothing written.'); return 0; }

  for (const p of ['.api-dead-ends', ...files.map(([x]) => x)]) if (await isLink(join(root, p))) throw new UsageError(`${p} is a symbolic link — refusing to write through it.`);
  if (!f.force) for (const [p] of files) if (await exists(join(root, p)) && !p.endsWith('.gitignore')) throw new UsageError(`${p} already exists. Re-run with --force to overwrite.`);
  for (const s of services) await mkdir(join(root, '.api-dead-ends', s.name), { recursive: true });
  if (f.force) await pruneEmptyDirs(join(root, '.api-dead-ends'), new Set(services.map((s) => s.name)));
  for (const [p, body] of files) if (f.force || !(await exists(join(root, p)))) await writeFile(join(root, p), body, { flag: f.force ? 'w' : 'wx' });

  say('');
  say(src.id === 'none'
    ? 'Done. No traffic source yet, so no report today — .api-dead-ends/NEXT-STEPS.md lists how to get one.'
    : `Done. Next: open .api-dead-ends/NEXT-STEPS.md (${buildSteps(config).reduce((a, s) => a + s.steps.length, 0)} steps).`);
  if (ai === 'mcp') {
    say('');
    say('MCP config (Cursor, VS Code, Claude Desktop, Windsurf) — add to your client settings:');
    const local = config.cmd && config.cmd.startsWith('node ') ? config.cmd.slice(5) : '';
    say(JSON.stringify({ mcpServers: { ade: local ? { command: 'node', args: [resolve(root, local), 'mcp'] } : { command: 'npx', args: ['-y', 'api-dead-ends@0.2.0', 'mcp'] } } }, null, 2));
    say(`Claude Code: claude mcp add ade -- ${local ? `node ${resolve(root, local)}` : 'npx -y api-dead-ends@0.2.0'} mcp`);
  }
  if (json) io.out.write(JSON.stringify({ config, steps: buildSteps(config), files: files.map(([p]) => p) }, null, 2) + '\n');
  return 0;
}

export class UsageError extends Error {}

/**
 * Line-by-line answers from a TTY or a pipe. When input ends, defaults are used.
 * @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} out
 */
function asker(input, out) {
  const rl = createInterface({ input, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  let closed = false;
  let got = 0;
  return async (/** @type {string} */ question, /** @type {string} */ def) => {
    out.write(question);
    if (closed) { out.write(def + '\n'); return def; }
    const r = await it.next();
    if (r.done) {
      if (!got) { out.write('\n'); throw new UsageError('No answers on input (no terminal?). Run init in a terminal, pipe answers one per line, or add --yes. See: api-dead-ends init --help'); }
      closed = true; out.write(`${def}\n`); return def;
    }
    got++;
    if (!process.stdin.isTTY) out.write(`${r.value}\n`);
    return r.value.trim() === '' ? def : r.value.trim();
  };
}

/** @template T @param {T[]} list @param {string} a @returns {T | undefined} */
function pick(list, a) {
  const n = Number(String(a).trim());
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
  return list.find((x) => /** @type {any} */ (x).id === String(a).trim());
}


/**
 * How the user ran us: `npx api-dead-ends` when installed from npm, otherwise `node <path to bin>` (local checkout).
 * @param {string} root
 */
function invocation(root) {
  const bin = process.argv[1] || '';
  if (/[\\/](_npx|node_modules)[\\/]/.test(bin) || !bin) return 'npx api-dead-ends';
  const rel = relative(root, bin);
  return `node ${rel.startsWith('..') && rel.split('/').length > 4 ? bin : rel}`;
}

/** Remove empty per-service folders that are no longer in the config (never touches non-empty ones). @param {string} dir @param {Set<string>} keep */
async function pruneEmptyDirs(dir, keep) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory() && !keep.has(e.name)) { try { await rmdir(join(dir, e.name)); } catch { /* not empty: keep */ } }
}

/** @param {string} p */
async function isLink(p) {
  try { return (await lstat(p)).isSymbolicLink(); } catch { return false; }
}

/** @param {string} p */
async function exists(p) {
  try { await lstat(p); return true; } catch { return false; }
}
