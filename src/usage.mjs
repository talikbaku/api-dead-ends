// @ts-check
// Usage table — the common input for all sources.
// Row: { method, path, calls, first_seen?, last_seen?, status: Map<code, count> }
// CSV: method,path,calls,first_seen,last_seen,status   (status = "200:10|500:2")

import { templatePath } from './template.mjs';

/**
 * @typedef {{ method: string, path: string, calls: number, first_seen: string, last_seen: string, status: Map<string, number>, day?: string }} UsageRow
 */

/** @param {string} s */
export function parseStatus(s) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const kv of String(s || '').split('|').filter(Boolean)) {
    const i = kv.lastIndexOf(':');
    if (i < 0) continue;
    const code = kv.slice(0, i).trim();
    const n = Number(kv.slice(i + 1));
    if (code && Number.isFinite(n)) m.set(code, (m.get(code) || 0) + n);
  }
  return m;
}

/** @param {Map<string, number>} m */
export function formatStatus(m) {
  return [...m].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join('|');
}

/**
 * Add a row to the map, merging by method+path (after path templating).
 * @param {Map<string, UsageRow>} acc
 * @param {{ method?: string, path: string, calls: number|string, first_seen?: string, last_seen?: string, status?: string|Map<string, number> }} r
 * @param {{ template?: boolean, keep?: Set<string>, daily?: boolean, dayFromTime?: boolean }} [opt]
 */
export function addRow(acc, r, opt = {}) {
  // Everything below comes from logs, i.e. from whoever sent the requests: keep it inert.
  const m = String(r.method || '').toUpperCase();
  const method = /^[A-Z]{1,10}$/.test(m) ? m : m ? 'OTHER' : 'ANY';
  const path = cleanText(opt.template === false ? String(r.path) : templatePath(r.path, { keep: opt.keep }));
  const calls = Number(String(r.calls ?? '').replace(/[,_\s]/g, '')) || 0;
  // With opt.daily, rows stay split per UTC day (YYYY-MM-DD) so reports can show 30/7/3/1-day windows.
  // the day comes from an explicit `day` field; raw events (access logs, per-day adapters) may derive it from their timestamp
  const day = opt.daily ? dayOf(r.day || (opt.dayFromTime ? r.first_seen : '')) : '';
  const key = day ? `${method} ${path} ${day}` : `${method} ${path}`;
  const o = acc.get(key) || { method, path, calls: 0, first_seen: '', last_seen: '', status: new Map(), ...(day ? { day } : {}) };
  o.calls += calls;
  // a per-day row without timestamps still tells us its day
  const dayTs = day ? `${day}T00:00:00.000Z` : '';
  const fs = isoOrEmpty(r.first_seen) || dayTs, ls = isoOrEmpty(r.last_seen) || dayTs;
  if (fs && (!o.first_seen || fs < o.first_seen)) o.first_seen = fs;
  if (ls && ls > o.last_seen) o.last_seen = ls;
  const st = r.status instanceof Map ? r.status
    : r.status && typeof r.status === 'object' ? new Map(Object.entries(r.status).map(([k, x]) => [k, Number(x)]))
    : parseStatus(String(r.status || ''));
  for (const [c, n] of st) if (/^([1-5]\d\d|[1-5]xx)$/i.test(c) && Number.isFinite(n)) o.status.set(c, (o.status.get(c) || 0) + n);
  acc.set(key, o);
  return acc;
}

/**
 * @param {string} text CSV, JSON (array) or JSONL
 * @param {{ keep?: Set<string>, daily?: boolean }} [opt]  daily: keep the per-day split if the input has a day column
 * @returns {UsageRow[]}
 */
export function parseUsage(text, opt = {}) {
  const t = text.trim();
  /** @type {Map<string, UsageRow>} */
  const acc = new Map();
  if (!t) return [];
  if (t.startsWith('[')) {
    for (const r of JSON.parse(t)) addRow(acc, r, opt);
  } else if (t.startsWith('{')) {
    for (const line of t.split('\n').filter((l) => l.trim())) addRow(acc, JSON.parse(line), opt);
  } else {
    const rows = parseCsv(t);
    const head = rows[0].map((h) => h.trim().toLowerCase());
    for (const need of ['path', 'calls']) {
      if (!head.includes(need)) throw new Error(`CSV: no "${need}" column (found: ${head.join(', ')})`);
    }
    for (const cells of rows.slice(1)) {
      if (cells.length === 1 && !cells[0]) continue;
      /** @type {any} */
      const r = Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
      addRow(acc, r, opt);
    }
  }
  return [...acc.values()];
}

/** @param {unknown} v → 'YYYY-MM-DD' or '' */
function dayOf(v) {
  const s = String(v || '');
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return s;
  const iso = isoOrEmpty(s);
  return iso ? iso.slice(0, 10) : '';
}

/** Drop control characters (newlines would break Markdown tables and could smuggle text into AI prompts). @param {string} s */
export function cleanText(s) {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').slice(0, 300);
}

/** Only real dates survive; anything else (e.g. "=cmd|...") becomes empty. @param {unknown} v */
function isoOrEmpty(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{10,13}(\.\d+)?$/.test(s)) { const n = Number(s); return new Date(n < 1e12 ? n * 1000 : n).toISOString(); }
  if (!/^\d{4}-\d\d-\d\d/.test(s)) return ''; // only real dates: never formulas or free text
  const t = Date.parse(s.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/** @param {UsageRow[]} rows */
export function toCsv(rows) {
  const daily = rows.some((r) => r.day);
  const cols = ['method', 'path', 'calls', 'first_seen', 'last_seen', 'status', ...(daily ? ['day'] : [])];
  const q = (/** @type {unknown} */ v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => [r.method, r.path, r.calls, r.first_seen, r.last_seen, formatStatus(r.status), ...(daily ? [r.day || ''] : [])].map(q).join(','));
  return [cols.join(','), ...lines].join('\n') + '\n';
}

/** @param {string} text */
export function parseCsv(text) {
  /** @type {string[][]} */
  const out = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); out.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}
