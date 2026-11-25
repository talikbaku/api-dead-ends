// @ts-check
// Usage table — the common input for all sources.
// Row: { method, path, calls, first_seen?, last_seen?, status: Map<code, count> }
// CSV: method,path,calls,first_seen,last_seen,status   (status = "200:10|500:2")

import { templatePath } from './template.mjs';

/**
 * @typedef {{ method: string, path: string, calls: number, first_seen: string, last_seen: string, status: Map<string, number> }} UsageRow
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
 * @param {{ template?: boolean, keep?: Set<string> }} [opt]
 */
export function addRow(acc, r, opt = {}) {
  // Everything below comes from logs, i.e. from whoever sent the requests: keep it inert.
  const m = String(r.method || '').toUpperCase();
  const method = /^[A-Z]{1,10}$/.test(m) ? m : m ? 'OTHER' : 'ANY';
  const path = cleanText(opt.template === false ? String(r.path) : templatePath(r.path, { keep: opt.keep }));
  const calls = Number(r.calls) || 0;
  const key = `${method} ${path}`;
  const o = acc.get(key) || { method, path, calls: 0, first_seen: '', last_seen: '', status: new Map() };
  o.calls += calls;
  const fs = isoOrEmpty(r.first_seen), ls = isoOrEmpty(r.last_seen);
  if (fs && (!o.first_seen || fs < o.first_seen)) o.first_seen = fs;
  if (ls && ls > o.last_seen) o.last_seen = ls;
  const st = r.status instanceof Map ? r.status : parseStatus(r.status || '');
  for (const [c, n] of st) if (/^([1-5]\d\d|[1-5]xx)$/i.test(c) && Number.isFinite(n)) o.status.set(c, (o.status.get(c) || 0) + n);
  acc.set(key, o);
  return acc;
}

/**
 * @param {string} text CSV, JSON (array) or JSONL
 * @param {{ keep?: Set<string> }} [opt]
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

/** Drop control characters (newlines would break Markdown tables and could smuggle text into AI prompts). @param {string} s */
export function cleanText(s) {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').slice(0, 300);
}

/** Only real dates survive; anything else (e.g. "=cmd|...") becomes empty. @param {unknown} v */
function isoOrEmpty(v) {
  if (!v) return '';
  const s = String(v);
  return /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s) && Number.isFinite(Date.parse(s)) ? s : '';
}

/** @param {UsageRow[]} rows */
export function toCsv(rows) {
  const cols = ['method', 'path', 'calls', 'first_seen', 'last_seen', 'status'];
  const q = (/** @type {unknown} */ v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => [r.method, r.path, r.calls, r.first_seen, r.last_seen, formatStatus(r.status)].map(q).join(','));
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
