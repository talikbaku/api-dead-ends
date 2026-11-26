// @ts-check
// Time windows over a per-day usage table: the whole period, the last 7, 3 and 1 days.
// A window is "the last N days that have data" (ending at the latest day in the table, not today).

import { classify, sumStatus } from './classify.mjs';
import { addRow } from './usage.mjs';
import { matchOp } from './spec.mjs';

export const WINDOWS = [null, 7, 3, 1];

/**
 * @param {import('./usage.mjs').UsageRow[]} rows  rows with a `day` (rows without one belong to every window)
 * @param {Parameters<typeof classify>[1]} spec
 * @param {Parameters<typeof classify>[2] & { now?: number, includeToday?: boolean }} [opt]
 */
export function computeWindows(rows, spec, opt = {}) {
  let days = [...new Set(rows.map((r) => r.day).filter(Boolean))].sort();
  if (!days.length) return null;
  // Today's data is partial (an export runs mid-day): leave it out so "1 day" is a whole day.
  const today = (opt.now ? new Date(opt.now) : new Date()).toISOString().slice(0, 10);
  const droppedToday = !opt.includeToday && days.length > 1 && days.at(-1) === today;
  if (droppedToday) { days = days.slice(0, -1); rows = rows.filter((r) => r.day !== today); }
  const first = days[0];
  const last = /** @type {string} */ (days.at(-1));
  const total = Math.round((Date.parse(last) - Date.parse(first)) / 86400e3) + 1; // calendar days, not days with data
  /** @type {Record<string, ReturnType<typeof classify>>} */
  const windows = {};
  for (const n of WINDOWS) {
    if (n !== null && n >= total) continue; // the whole period already covers it
    const from = n === null ? first : shiftDay(last, -(n - 1));
    const acc = new Map();
    for (const r of rows) if (!r.day || r.day >= from) addRow(acc, { ...r, day: undefined }, { template: false });
    windows[n === null ? 'all' : String(n)] = classify([...acc.values()], spec, { ...opt, days: n === null ? total : n });
  }
  // Per-day series per operation (calls and 5xx), for sparklines.
  /** @type {Record<string, { calls: number[], e5: number[] }>} */
  const series = {};
  const all = windows.all;
  const idx = new Map(days.map((d, i) => [d, i]));
  for (const r of rows) {
    if (!r.day) continue;
    const op = matchOp(spec.ops, r.method, r.path);
    const k = op ? `${op.method} ${op.path}` : `${r.method} ${r.path}`;
    const s = (series[k] ||= { calls: Array(days.length).fill(0), e5: Array(days.length).fill(0) });
    const i = /** @type {number} */ (idx.get(r.day));
    s.calls[i] += r.calls;
    s.e5[i] += sumStatus(r.status, (c) => c >= 500);
  }
  // Recent spikes: over the threshold in a short window AND at least 3× the share of the days before it.
  // (Comparing with the days before — not with the whole period — keeps a big incident from hiding itself.)
  const spikes = [];
  for (const n of ['1', '3', '7']) {
    const w = windows[n];
    if (!w) continue;
    const from = shiftDay(last, -(Number(n) - 1));
    const acc = new Map();
    for (const r of rows) if (r.day && r.day < from) addRow(acc, { ...r, day: undefined }, { template: false });
    if (!acc.size) continue;
    const before = classify([...acc.values()], spec, { ...opt, days: total - Number(n) });
    for (const e of w.serverErrors) {
      if (spikes.some((x) => x.method === e.method && x.path === e.path)) continue;
      const b = before.endpoints.find((x) => x.method === e.method && x.path === e.path);
      const share = e.errors5xx / e.calls;
      const beforeShare = b && b.calls ? b.errors5xx / b.calls : 0;
      if (share < 3 * beforeShare) continue;
      spikes.push({ method: e.method, path: e.path, window: Number(n), calls: e.calls, errors5xx: e.errors5xx, share, wholeShare: beforeShare, before: 'days before the window' });
    }
  }
  spikes.sort((a, b) => b.errors5xx - a.errors5xx);
  return { days, windows, series, spikes, droppedToday };
}

/** @param {string} day @param {number} n */
function shiftDay(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
}
