// @ts-check
// `probe <url>`: open a site in a real browser and record the API calls its pages make.
// Finds requests sent several times per page load, broken (4xx/5xx/network/CORS) and slow requests,
// and — with a spec — which documented endpoints the front end calls.
// Safety: navigation only (no clicks, no forms), same origin, page cap, logout/delete-like links skipped,
// nothing saved from the session, only templated paths in the output. CLI only (not an MCP tool).

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { templatePath } from './template.mjs';
import { matchOp } from './spec.mjs';

const SKIP_LINK = /log-?out|sign-?out|log-?off|delete|remove|destroy|unsubscribe|cancel|deactivate|disable|revoke|purge|reset|clear|close|archive|approve|reject|confirm|pay|checkout\/(submit|confirm)|\.(pdf|zip|gz|dmg|exe|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4|webm)(\?|$)/i;
/** Never follow links into API paths, and judge the decoded URL (/log%6Fut is /logout). @param {URL} u */
const skipLink = (u) => { let p = u.pathname + u.search; try { p = decodeURIComponent(p); } catch { /* keep raw */ } return SKIP_LINK.test(p) || /(^|\/)api(\/|$)/i.test(u.pathname); };
/** Playwright messages include the URL: drop query strings and fragments before printing. @param {unknown} e */
const cleanErr = (e) => String(/** @type {any} */ (e)?.message || e).split('\n')[0].replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 120);

/** @param {any} req */
function keyOf(req) {
  const u = new URL(req.url());
  const body = req.postData() || '';
  const h = body ? createHash('sha256').update(body).digest('base64').slice(0, 10) : '';
  return `${req.method()} ${u.host}${u.pathname}${u.search} ${h}`;
}

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
 * @param {{ url: string, apiHosts?: string[], pages?: number, login?: boolean, slowMs?: number, settleMs?: number, spec?: any, headed?: boolean, log?: (s: string) => void, waitForEnter?: () => Promise<void> }} o
 */
export async function probe(o) {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('probe needs Playwright in your project (npm i -D playwright && npx playwright install chromium), or set API_DEAD_ENDS_PLAYWRIGHT to its path');
  const log = o.log || (() => {});
  const start = new URL(o.url);
  if (!/^https?:$/.test(start.protocol)) throw new Error('probe: only http(s) URLs');
  const maxPages = o.pages ?? 20;
  const slowMs = o.slowMs ?? 2000;
  const browser = await pw.chromium.launch({ headless: !(o.login || o.headed) });
  const ctx = await browser.newContext(); // fresh context: no saved cookies, nothing written to disk
  // Documents may only load from the start origin (redirects, meta refresh, location= are stopped); popups are closed.
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (req.resourceType() !== 'document' || (o.login && loggingIn)) return route.continue();
    if (new URL(req.url()).origin !== start.origin) return route.abort();
    // Server redirects are followed inside one request: fetch without following, and hand the 3xx to the browser,
    // whose next request (the Location) comes back through this filter.
    try {
      const resp = await route.fetch({ maxRedirects: 0 });
      const loc = resp.headers().location;
      if (resp.status() >= 300 && resp.status() < 400 && loc && new URL(loc, req.url()).origin !== start.origin) return route.abort();
      return route.fulfill({ response: resp });
    } catch {
      return route.abort();
    }
  });
  let loggingIn = false;
  const page = await ctx.newPage();
  ctx.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
  /** @type {Array<{ page: string, method: string, path: string, host: string, status: number, ms: number | null, perLoad: number, problem: string }>} */
  const rows = [];
  const visited = new Set();
  const queue = [start.href];
  let requests = 0;
  try {
    if (o.login) {
      loggingIn = true; // SSO login pages may live on another origin
      await page.goto(start.href).catch(() => {});
      log('Log in in the browser window, then press Enter here.');
      if (o.waitForEnter) await o.waitForEnter();
      loggingIn = false;
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
        const k = keyOf(req); // same method, exact URL and body: what "the same request twice" means
        const prev = seen.get(k);
        if (prev) prev.n++;
        else seen.set(k, { method: req.method(), path: templatePath(u.pathname), host: u.host, n: 1, status: 0, ms: null, failed: '' });
      };
      const onRes = (/** @type {any} */ res) => {
        const req = res.request();
        if (!t0.has(req)) return;
        const e = seen.get(keyOf(req));
        if (e) { const st = res.status(); if (st >= e.status) e.status = st; const ms = Date.now() - t0.get(req); if (e.ms == null || ms > e.ms) e.ms = ms; } // keep the worst
      };
      const onFail = (/** @type {any} */ req) => {
        if (!t0.has(req)) return;
        const e = seen.get(keyOf(req));
        if (e) e.failed = String(req.failure()?.errorText || 'failed').split('\n')[0].slice(0, 80);
      };
      page.on('request', onReq);
      page.on('response', onRes);
      page.on('requestfailed', onFail);
      const pagePath = templatePath(new URL(key).pathname);
      try {
        await page.goto(key, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (e) {
        log(`${pagePath}: ${cleanErr(e)}`);
      }
      await page.waitForTimeout(o.settleMs ?? 500);
      page.off('request', onReq);
      page.off('response', onRes);
      page.off('requestfailed', onFail);
      if (new URL(page.url()).origin !== start.origin) { log(`${pagePath}: left the site, skipped`); continue; }
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
        if (u.origin !== start.origin || skipLink(u)) continue;
        const k = u.href.split('#')[0];
        if (!visited.has(k) && !queue.includes(k)) queue.push(k);
      }
    }
  } finally {
    await browser.close();
  }
  // Merge identical (page, method, host, path) rows from different query strings / bodies.
  /** @type {Map<string, any>} */
  const merged = new Map();
  for (const r of rows) {
    const k = `${r.page} ${r.method} ${r.host} ${r.path}`;
    const m = merged.get(k);
    if (!m) { merged.set(k, { ...r }); continue; }
    m.perLoad = Math.max(m.perLoad, r.perLoad);
    if (r.status >= m.status) m.status = r.status;
    if (r.ms != null && (m.ms == null || r.ms > m.ms)) m.ms = r.ms;
    m.problem = [...new Set([m.problem, r.problem].join(', ').split(', ').filter(Boolean))].join(', ');
  }
  rows.length = 0;
  rows.push(...merged.values());
  const result = {
    url: start.origin + templatePath(start.pathname),
    when: new Date().toISOString(),
    pages: visited.size,
    requests,
    note: 'Navigation only (no clicks or forms). Duplicates = the same request sent more than once in one page load. Development builds (e.g. React StrictMode) send some requests twice on purpose — probe a production build.',
    rows: rows.sort((a, b) => (a.problem ? 0 : 1) - (b.problem ? 0 : 1) || b.perLoad - a.perLoad),
  };
  if (o.spec) {
    // Spec coverage counts calls to the site's own host only (analytics and third-party APIs are left out).
    const own = rows.filter((r) => r.host === start.host || (o.apiHosts || []).includes(r.host));
    const called = new Set();
    for (const r of own) { const op = matchOp(o.spec.ops, r.method, r.path); if (op) called.add(`${op.method} ${op.path}`); }
    /** @type {any} */ (result).notCalledByFrontend = o.spec.ops.filter((op) => !called.has(`${op.method} ${op.path}`)).map((op) => ({ method: op.method, path: op.path }));
    /** @type {any} */ (result).notInSpec = [...new Set(own.filter((r) => !matchOp(o.spec.ops, r.method, r.path)).map((r) => `${r.method} ${r.path}`))];
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
