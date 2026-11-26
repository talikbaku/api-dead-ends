// @ts-check
// `probe <url>`: open a site in a real browser and record the API calls its pages make.
// Finds requests sent several times per page load, broken (4xx/5xx/network/CORS) and slow requests,
// and — with a spec — which documented endpoints the front end calls.
// Safety: navigation only (no clicks, no forms), same origin, page cap, logout/delete-like links skipped,
// nothing saved from the session, only templated paths in the output. CLI only (not an MCP tool).

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { templatePath } from './template.mjs';
import { matchOp } from './spec.mjs';

const SKIP_LINK = /log-?out|sign-?out|logoff|delete|remove|destroy|unsubscribe|cancel|deactivate|revoke|\.(pdf|zip|gz|dmg|exe|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4|webm)(\?|$)/i;

/** Load Playwright from the user's project first, then from wherever Node can find it. */
export async function loadPlaywright(cwd = process.cwd()) {
  const tries = [];
  if (process.env.API_DEAD_ENDS_PLAYWRIGHT) tries.push(process.env.API_DEAD_ENDS_PLAYWRIGHT);
  for (const base of [cwd + '/', import.meta.url]) {
    try { tries.push(createRequire(base).resolve('playwright')); } catch { /* not there */ }
  }
  for (const t of tries) {
    try { const m = await import(t.startsWith('file:') ? t : pathToFileURL(t).href); return m.chromium ? m : m.default; } catch { /* next */ }
  }
  return null;
}

/**
 * @param {{ url: string, pages?: number, login?: boolean, slowMs?: number, settleMs?: number, spec?: any, headed?: boolean, log?: (s: string) => void, waitForEnter?: () => Promise<void> }} o
 */
export async function probe(o) {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('probe needs Playwright in your project or globally: npm i -D playwright && npx playwright install chromium');
  const log = o.log || (() => {});
  const start = new URL(o.url);
  if (!/^https?:$/.test(start.protocol)) throw new Error('probe: only http(s) URLs');
  const maxPages = o.pages ?? 20;
  const slowMs = o.slowMs ?? 2000;
  const browser = await pw.chromium.launch({ headless: !(o.login || o.headed) });
  const ctx = await browser.newContext(); // fresh context: no saved cookies, nothing written to disk
  const page = await ctx.newPage();
  /** @type {Array<{ page: string, method: string, path: string, host: string, status: number, ms: number | null, perLoad: number, problem: string }>} */
  const rows = [];
  const visited = new Set();
  const queue = [start.href];
  let requests = 0;
  try {
    if (o.login) {
      await page.goto(start.href).catch(() => {});
      log('Log in in the browser window, then press Enter here.');
      if (o.waitForEnter) await o.waitForEnter();
    }
    while (queue.length && visited.size < maxPages) {
      const href = /** @type {string} */ (queue.shift());
      const key = href.split('#')[0];
      if (visited.has(key)) continue;
      visited.add(key);
      /** @type {Map<string, { method: string, path: string, host: string, n: number, status: number, ms: number | null, failed: string }>} */
      const seen = new Map();
      const t0 = new Map();
      const onReq = (/** @type {any} */ req) => {
        const type = req.resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        if (req.method() === 'OPTIONS') return;
        t0.set(req, Date.now());
        const u = new URL(req.url());
        const k = `${req.method()} ${u.host}${u.pathname}${u.search}`; // exact URL: what "the same request twice" means
        const prev = seen.get(k);
        if (prev) prev.n++;
        else seen.set(k, { method: req.method(), path: templatePath(u.pathname), host: u.host, n: 1, status: 0, ms: null, failed: '' });
      };
      const onRes = (/** @type {any} */ res) => {
        const req = res.request();
        if (!t0.has(req)) return;
        const u = new URL(req.url());
        const e = seen.get(`${req.method()} ${u.host}${u.pathname}${u.search}`);
        if (e) { e.status = res.status(); e.ms = Date.now() - t0.get(req); }
      };
      const onFail = (/** @type {any} */ req) => {
        if (!t0.has(req)) return;
        const u = new URL(req.url());
        const e = seen.get(`${req.method()} ${u.host}${u.pathname}${u.search}`);
        if (e) e.failed = String(req.failure()?.errorText || 'failed').split('\n')[0].slice(0, 80);
      };
      page.on('request', onReq);
      page.on('response', onRes);
      page.on('requestfailed', onFail);
      const pagePath = templatePath(new URL(key).pathname);
      try {
        await page.goto(key, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (e) {
        log(`${pagePath}: ${String(/** @type {Error} */ (e).message).split('\n')[0].slice(0, 80)}`);
      }
      await page.waitForTimeout(o.settleMs ?? 500);
      page.off('request', onReq);
      page.off('response', onRes);
      page.off('requestfailed', onFail);
      for (const e of seen.values()) {
        requests += e.n;
        const problem = e.failed ? (/cors|blocked/i.test(e.failed) ? 'cors' : 'network') : e.status >= 500 ? 'server error' : e.status >= 400 ? 'client error' : e.n > 1 ? 'duplicate' : e.ms != null && e.ms > slowMs ? 'slow' : '';
        rows.push({ page: pagePath, method: e.method, path: e.path, host: e.host, status: e.status, ms: e.ms, perLoad: e.n, problem: e.n > 1 && problem !== 'duplicate' ? `${problem}, duplicate` : problem });
      }
      log(`${pagePath}: ${seen.size} API calls`);
      // same-origin links only
      const links = await page.$$eval('a[href]', (as) => as.map((a) => /** @type {HTMLAnchorElement} */ (a).href)).catch(() => []);
      for (const l of links) {
        let u;
        try { u = new URL(l); } catch { continue; }
        if (u.origin !== start.origin || SKIP_LINK.test(u.href)) continue;
        const k = u.href.split('#')[0];
        if (!visited.has(k) && !queue.includes(k)) queue.push(k);
      }
    }
  } finally {
    await browser.close();
  }
  // Merge identical (page, method, path) rows from different query strings.
  const result = {
    url: start.origin + templatePath(start.pathname),
    when: new Date().toISOString(),
    pages: visited.size,
    requests,
    note: 'Navigation only (no clicks or forms). Duplicates = the same request sent more than once in one page load. Development builds (e.g. React StrictMode) send some requests twice on purpose — probe a production build.',
    rows: rows.sort((a, b) => (a.problem ? 0 : 1) - (b.problem ? 0 : 1) || b.perLoad - a.perLoad),
  };
  if (o.spec) {
    const called = new Set();
    for (const r of rows) { const op = matchOp(o.spec.ops, r.method, r.path); if (op) called.add(`${op.method} ${op.path}`); }
    /** @type {any} */ (result).notCalledByFrontend = o.spec.ops.filter((op) => !called.has(`${op.method} ${op.path}`)).map((op) => ({ method: op.method, path: op.path }));
    /** @type {any} */ (result).notInSpec = [...new Set(rows.filter((r) => !matchOp(o.spec.ops, r.method, r.path)).map((r) => `${r.method} ${r.path}`))];
  }
  return result;
}

/** @param {any} p */
export function probeToMarkdown(p) {
  const code = (/** @type {string} */ s) => `\`${String(s).replace(/[\u0000-\u001f`|]/g, ' ')}\``;
  const L = [`# api-dead-ends probe: ${code(p.url)}`, '', `${p.pages} pages, ${p.requests} API requests. ${p.note}`, ''];
  const bad = p.rows.filter((/** @type {any} */ r) => r.problem);
  L.push('## Problems', '');
  if (!bad.length) L.push('_None._', '');
  else {
    L.push('| Page | Method | Path | Status | ms | Per load | Problem |', '|---|---|---|---:|---:|---:|---|');
    for (const r of bad) L.push(`| ${code(r.page)} | ${r.method} | ${code(r.path)} | ${r.status || '—'} | ${r.ms ?? '—'} | ${r.perLoad} | ${r.problem} |`);
    L.push('');
  }
  if (p.notInSpec) {
    L.push('## Called by the front end, not in the spec', '', ...(p.notInSpec.length ? p.notInSpec.map((/** @type {string} */ x) => `- ${code(x)}`) : ['_None._']), '');
    L.push('## In the spec, not called by the pages visited', '', ...(p.notCalledByFrontend.length ? p.notCalledByFrontend.map((/** @type {any} */ x) => `- ${code(`${x.method} ${x.path}`)}`) : ['_None._']), '',
      '> Only the pages reached by links were visited, without clicks or forms: an endpoint listed here may still be called after a user action.', '');
  }
  return L.join('\n');
}
