// @ts-check
// Static "Not logged" check: places in code and config that switch request logging off for some paths.
// Rules only for patterns we can recognise reliably; everything else is reported as "unknown" — never guessed.
// Read-only: scans text files (≤ 512 KB) under the repo, skipping vendored and build folders.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', 'out', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.api-dead-ends']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.go', '.py', '.rb', '.conf', '.yml', '.yaml', '.java', '.kt', '.xml', '.cs', '.json', '.sh', '.toml', '.ini', '.cfg', '']);

/**
 * Each rule: which files, a regex per line, and what it means.
 * @type {Array<{ id: string, framework: string, files: RegExp, re: RegExp, what: string }>}
 */
const RULES = [
  { id: 'nginx-access-log-off', framework: 'nginx', files: /\.conf$|nginx/i, re: /(^|[{;\s])access_log\s+off\s*;/, what: 'access_log off — requests in this server/location block are not logged' },
  { id: 'ingress-access-log-false', framework: 'ingress-nginx', files: /\.ya?ml$/i, re: /nginx\.ingress\.kubernetes\.io\/enable-access-log:\s*["']?false/i, what: 'ingress access log disabled for this Ingress' },
  { id: 'morgan-skip', framework: 'express (morgan)', files: /\.[cm]?[jt]sx?$/, re: /morgan\s*\([^)]*\bskip\s*:/, what: 'morgan skip rule — some requests are not logged' },
  { id: 'pino-http-ignore', framework: 'express/fastify (pino-http)', files: /\.[cm]?[jt]sx?$/, re: /autoLogging\s*:\s*(false|\{[^}]*ignore)/, what: 'pino-http autoLogging off or ignore rule' },
  { id: 'fastify-disable-request-logging', framework: 'fastify', files: /\.[cm]?[jt]sx?$/, re: /disableRequestLogging\s*:\s*true/, what: 'fastify disableRequestLogging: no request logs' },
  { id: 'gin-skip-paths', framework: 'gin', files: /\.go$/, re: /SkipPaths\s*:/, what: 'gin logger SkipPaths — listed paths are not logged' },
  { id: 'echo-skipper', framework: 'echo', files: /\.go$/, re: /LoggerWithConfig\s*\(\s*middleware\.LoggerConfig\s*\{[^}]*Skipper/, what: 'echo logger Skipper — some requests are not logged' },
  { id: 'uvicorn-no-access-log', framework: 'uvicorn / FastAPI', files: /Dockerfile|Procfile|\.ya?ml$|\.sh$|\.toml$|\.py$/i, re: /--no-access-log|access_log\s*=\s*False/, what: 'uvicorn access log disabled' },
  { id: 'gunicorn-no-access-log', framework: 'gunicorn', files: /Dockerfile|Procfile|\.ya?ml$|\.sh$|\.py$|\.conf$/i, re: /accesslog\s*=\s*None/, what: 'gunicorn access log disabled' },
  { id: 'lograge-ignore', framework: 'rails (lograge)', files: /\.rb$/, re: /lograge\.ignore_(actions|custom)/, what: 'lograge ignore rule — some actions are not logged' },
  { id: 'next-middleware-matcher', framework: 'next.js', files: /(^|\/)middleware\.[jt]s$/, re: /matcher\s*:/, what: 'middleware matcher — paths outside it skip this middleware (and any logging it does)' },
  { id: 'spring-exclude-path', framework: 'spring', files: /\.(java|kt)$/, re: /excludePathPatterns\s*\(/, what: 'interceptor excludePathPatterns — excluded paths skip this interceptor (and its logging, if any)' },
  { id: 'aspnet-serilog-filter', framework: 'asp.net', files: /\.cs$/, re: /UseSerilogRequestLogging\s*\([^)]*GetLevel|Filter\.ByExcluding/, what: 'Serilog request logging filter — some requests are dropped' },
];

/**
 * @param {string} root
 * @param {{ frameworks?: string[] }} [opt]  frameworks found by detect: those without rules are listed as "unknown"
 */
export async function logCheck(root, opt = {}) {
  /** @type {Array<{ file: string, line: number, rule: string, framework: string, what: string, text: string }>} */
  const findings = [];
  let files = 0;
  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    if (depth > 8 || files > 20000) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      const rel = relative(root, p);
      const rules = RULES.filter((r) => r.files.test(rel) || r.files.test(basename(rel)));
      if (!rules.length || !(EXT.has(extname(e.name)) || /Dockerfile|Procfile/.test(e.name))) continue;
      files++;
      let text = '';
      try { if ((await stat(p)).size > 512 * 1024) continue; text = await readFile(p, 'utf8'); } catch { continue; }
      const lines = text.split(/\r?\n/);
      lines.forEach((ln, i) => {
        if (ln.length > 4000) return; // minified or generated: no real config line is this long (keeps regexes cheap)
        const win = [ln, ...lines.slice(i + 1, i + 4).map((x) => x.slice(0, 400))].join(' '); // options often continue on the next lines
        for (const r of rules) if (r.re.test(ln) || (/morgan|autoLogging|LoggerWithConfig|UseSerilogRequestLogging/.test(ln) && r.re.test(win))) findings.push({ file: rel, line: i + 1, rule: r.id, framework: r.framework, what: r.what, text: ln.trim().slice(0, 160) });
      });
    }
  }
  await walk(root, 0);
  const covered = new Set(['express', 'fastify', 'gin', 'echo', 'fastapi', 'rails', 'next', 'spring', 'aspnetcore']);
  const unknown = (opt.frameworks || []).filter((f) => !covered.has(f));
  return {
    findings,
    unknown,
    note: 'Rules find explicit "do not log" settings. They cannot see middleware order, custom loggers or sampling — for that, compare two traffic sources (`coverage`) or ask an AI assistant to read the handlers.',
  };
}
