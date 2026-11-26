// @ts-check
// "What changed": today (up to the last full hour) against the same hours on the previous days.
// Needs a per-hour usage table (`--hourly`). Totals per hour, endpoints whose calls or errors moved most,
// new and vanished endpoints, peak load, and for error spikes the first hour they started.
// "Today" is the UTC day of the last full hour in the data.

import { matchOp } from './spec.mjs';
import { sumStatus } from './classify.mjs';

/**
 * @param {import('./usage.mjs').UsageRow[]} rows  rows with `hour` ('YYYY-MM-DDTHH', UTC)
 * @param {{ ops: any[] }} spec
 * @param {{ now?: number, days?: number, minCalls?: number }} [opt]  days: how many previous days to compare with (default 2)
 */
export function computeChanges(rows, spec, opt = {}) {
  const hrs = [...new Set(rows.map((r) => r.hour).filter(Boolean))].sort();
  if (!hrs.length) return null;
  const nowHour = new Date(opt.now ?? Date.now()).toISOString().slice(0, 13);
  // the current hour is still filling up; so is the last hour of an export made mid-hour (known from real last_seen times)
  let dataEnd = -Infinity, precise = false;
  for (const r of rows) {
    const t = Date.parse(r.last_seen);
    if (!Number.isFinite(t)) continue;
    if (t % 3600e3 !== 0) precise = true;
    if (t > dataEnd) dataEnd = t;
  }
  if (!precise) dataEnd = Infinity;
  const full = hrs.filter((h) => h < nowHour && Date.parse(`${h}:00:00Z`) + 3600e3 <= dataEnd + 120e3); // 2 min slack for late records
  if (!full.length) return null;
  const lastHour = /** @type {string} */ (full.at(-1));
  const today = lastHour.slice(0, 10);
  const upTo = Number(lastHour.slice(11, 13)); // hours 00..upTo are compared
  const H = upTo + 1;
  const candidates = Array.from({ length: opt.days ?? 2 }, (_, i) => shift(today, -(i + 1)));
  // a previous day counts for an hour only if the data has that hour (an export may start mid-day)
  const hrSet = new Set(hrs);
  const daysAt = Array.from({ length: H }, (_, h) => candidates.filter((d) => hrSet.has(`${d}T${String(h).padStart(2, '0')}`)).length);
  const prevDays = candidates.filter((d) => hrs.some((h) => h.startsWith(d)));
  const keyOf = (/** @type {any} */ r) => { const op = matchOp(spec.ops, r.method, r.path); return op ? `${op.method} ${op.path}` : `${r.method} ${r.path}`; };

  /** @typedef {{ calls: number[], e5: number[], e4: number[] }} Hours */
  /** @returns {Hours} */
  const hours = () => ({ calls: Array(H).fill(0), e5: Array(H).fill(0), e4: Array(H).fill(0) });
  /** @type {Map<string, { method: string, path: string, inSpec: boolean, today: Hours, before: Hours }>} */
  const by = new Map();
  const tot = { today: hours(), before: hours() };
  for (const r of rows) {
    if (!r.hour) continue;
    const day = r.hour.slice(0, 10), h = Number(r.hour.slice(11, 13));
    if (h > upTo) continue;
    const side = day === today ? 'today' : candidates.includes(day) ? 'before' : null;
    if (!side) continue;
    const k = keyOf(r);
    let e = by.get(k);
    if (!e) {
      const [method, ...p] = k.split(' ');
      e = { method, path: p.join(' '), inSpec: !!matchOp(spec.ops, r.method, r.path), today: hours(), before: hours() };
      by.set(k, e);
    }
    const e5 = sumStatus(r.status, (c) => c >= 500), e4 = sumStatus(r.status, (c) => c >= 400 && c < 500);
    for (const t of [e[side], tot[side]]) { t.calls[h] += r.calls; t.e5[h] += e5; t.e4[h] += e4; }
  }
  /** per-hour average over the previous days that have that hour @param {number[]} a */
  const avgH = (a) => a.map((x, h) => (daysAt[h] ? x / daysAt[h] : 0));
  const sum = (/** @type {number[]} */ a) => a.reduce((x, y) => x + y, 0);
  const min = opt.minCalls ?? 50;
  const list = [...by.values()].map((e) => {
    const b5 = avgH(e.before.e5);
    return {
      method: e.method, path: e.path, inSpec: e.inSpec,
      calls: sum(e.today.calls), callsBefore: sum(avgH(e.before.calls)), e5: sum(e.today.e5), e5Before: sum(b5), e4: sum(e.today.e4), e4Before: sum(avgH(e.before.e4)),
      firstErrorHour: firstBadHour(e.today.e5, b5),
      hourly5xx: e.today.e5,
      peakRps: e.today.calls.reduce((a, x) => Math.max(a, x), 0) / 3600,
    };
  });
  const base = prevDays.length > 0;
  const ratio = (/** @type {number} */ a, /** @type {number} */ b) => (a + 1) / (b + 1);
  const errorsUp = list.filter((x) => x.e5 - x.e5Before >= 10 && ratio(x.e5, x.e5Before) >= 3).sort((a, b) => (b.e5 - b.e5Before) - (a.e5 - a.e5Before));
  const clientErrorsUp = list.filter((x) => x.e4 - x.e4Before >= 50 && ratio(x.e4, x.e4Before) >= 2).sort((a, b) => (b.e4 - b.e4Before) - (a.e4 - a.e4Before));
  const callsUp = list.filter((x) => Math.max(x.calls, x.callsBefore) >= min && x.callsBefore > 0 && x.calls / x.callsBefore >= 1.5).sort((a, b) => b.calls / b.callsBefore - a.calls / a.callsBefore);
  const callsDown = list.filter((x) => x.calls > 0 && Math.max(x.calls, x.callsBefore) >= min && x.calls / Math.max(x.callsBefore, 1) <= 0.67).sort((a, b) => a.calls / Math.max(a.callsBefore, 1) - b.calls / Math.max(b.callsBefore, 1));
  const appeared = list.filter((x) => x.calls >= 20 && x.callsBefore === 0).sort((a, b) => b.calls - a.calls);
  const vanished = list.filter((x) => x.calls === 0 && x.callsBefore >= 20).sort((a, b) => b.callsBefore - a.callsBefore);
  // calls and 5xx up together: more load on an endpoint that now fails (retries, a client loop, an exhausted pool)
  const loadAndErrors = errorsUp.filter((x) => x.callsBefore > 0 && x.calls / x.callsBefore >= 1.3);
  const bCalls = avgH(tot.before.calls), b5 = avgH(tot.before.e5);
  const peakOf = (/** @type {number[]} */ a) => a.reduce((b, x, h) => (x > b.calls ? { hour: h, calls: x } : b), { hour: 0, calls: 0 });
  const pT = peakOf(tot.today.calls), pB = peakOf(bCalls);
  const none = (/** @type {typeof list} */ a) => (base ? a : []);
  return {
    today, upToHour: upTo, previousDays: prevDays,
    totals: { calls: sum(tot.today.calls), callsBefore: sum(bCalls), e5: sum(tot.today.e5), e5Before: sum(b5) },
    perHour: tot.today.calls.map((c, h) => ({ hour: h, calls: c, callsBefore: bCalls[h], e5: tot.today.e5[h], e5Before: b5[h] })),
    load: { peakHour: pT.hour, peakRps: pT.calls / 3600, peakHourBefore: pB.hour, peakRpsBefore: pB.calls / 3600 },
    errorsUp: none(errorsUp), clientErrorsUp: none(clientErrorsUp), loadAndErrors: none(loadAndErrors),
    callsUp: none(callsUp), callsDown: none(callsDown), appeared: none(appeared), vanished: none(vanished),
    note: base
      ? `Today (UTC day) 00:00–${String(upTo).padStart(2, '0')}:59 UTC against the same hours on ${prevDays.join(', ')} (average per hour over the days that have it).${precise ? '' : ' The data has no exact last-seen times: if it was exported mid-hour, the last hour is partial.'}`
      : 'No previous days in the data to compare with — fetch with --days 3 or more.',
  };
}

/** First hour where 5xx jump. @param {number[]} today @param {number[]} before */
export function firstBadHour(today, before) {
  const i = today.findIndex((n, h) => isBadHour(n, before[h] || 0));
  return i < 0 ? null : i;
}

/** 5xx in an hour: ≥ 10 and ≥ 5 × the same hour before + 5. @param {number} n @param {number} before */
export function isBadHour(n, before) { return n >= 10 && n >= 5 * before + 5; }

/** @param {string} day @param {number} n */
function shift(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
}

/** Requests per second, readable at any size. @param {number} x */
export function rps(x) {
  return x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x >= 0.01 ? x.toFixed(2) : x > 0 ? '<0.01' : '0';
}

/** Hour label in UTC and, optionally, in a named time zone. @param {string} day @param {number} h @param {string} [tz] */
export function hourLabel(day, h, tz) {
  const utc = `${String(h).padStart(2, '0')}:00 UTC`;
  if (!tz) return utc;
  try {
    const local = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(new Date(`${day}T${String(h).padStart(2, '0')}:00:00Z`));
    return `${utc} (${local})`;
  } catch { return utc; }
}
