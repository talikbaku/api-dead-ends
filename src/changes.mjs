// @ts-check
// "What changed": today (up to the last full hour) against the same hours on the previous days.
// Needs a per-hour usage table (`--hourly`). Totals per hour, endpoints whose calls or errors moved most,
// new and vanished endpoints, and for error spikes the first hour they started.

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
  const ends = rows.map((r) => Date.parse(r.last_seen)).filter(Number.isFinite);
  const precise = ends.some((t) => t % 3600e3 !== 0);
  const dataEnd = precise ? Math.max(...ends) : Infinity;
  const full = hrs.filter((h) => h < nowHour && Date.parse(`${h}:00:00Z`) + 3600e3 <= dataEnd + 120e3);
  if (!full.length) return null;
  const lastHour = /** @type {string} */ (full.at(-1));
  const today = lastHour.slice(0, 10);
  const upTo = Number(lastHour.slice(11, 13)); // hours 00..upTo are compared
  const prevDays = Array.from({ length: opt.days ?? 2 }, (_, i) => shift(today, -(i + 1))).filter((d) => hrs.some((h) => h.startsWith(d)));
  const inRange = (/** @type {string} */ h, /** @type {string} */ d) => h.startsWith(d) && Number(h.slice(11, 13)) <= upTo;
  const keyOf = (/** @type {any} */ r) => { const op = matchOp(spec.ops, r.method, r.path); return op ? `${op.method} ${op.path}` : `${r.method} ${r.path}`; };

  /** @type {Map<string, { method: string, path: string, inSpec: boolean, today: Agg, before: Agg, hoursToday: number[], hoursBefore: number[], callsHourToday: number[] }>} */
  const by = new Map();
  const perHour = Array.from({ length: upTo + 1 }, () => ({ today: 0, today5: 0, before: 0, before5: 0 }));
  for (const r of rows) {
    if (!r.hour) continue;
    const day = r.hour.slice(0, 10);
    const isToday = inRange(r.hour, today);
    const isBefore = prevDays.some((d) => inRange(/** @type {string} */ (r.hour), d));
    if (!isToday && !isBefore) continue;
    const k = keyOf(r);
    const [method, ...p] = k.split(' ');
    const e = by.get(k) || { method, path: p.join(' '), inSpec: !!matchOp(spec.ops, r.method, r.path), today: agg(), before: agg(), hoursToday: Array(upTo + 1).fill(0), hoursBefore: Array(upTo + 1).fill(0), callsHourToday: Array(upTo + 1).fill(0) };
    const e5 = sumStatus(r.status, (c) => c >= 500), e4 = sumStatus(r.status, (c) => c >= 400 && c < 500);
    const h = Number(r.hour.slice(11, 13));
    if (isToday) { e.today.calls += r.calls; e.today.e5 += e5; e.today.e4 += e4; e.hoursToday[h] += e5; e.callsHourToday[h] += r.calls; perHour[h].today += r.calls; perHour[h].today5 += e5; }
    else { e.before.calls += r.calls; e.before.e5 += e5; e.before.e4 += e4; e.hoursBefore[h] += e5; perHour[h].before += r.calls; perHour[h].before5 += e5; }
    void day;
    by.set(k, e);
  }
  const nPrev = Math.max(1, prevDays.length);
  const avg = (/** @type {number} */ x) => x / nPrev;
  const min = opt.minCalls ?? 50;
  const list = [...by.values()].map((e) => ({
    method: e.method, path: e.path, inSpec: e.inSpec,
    calls: e.today.calls, callsBefore: avg(e.before.calls), e5: e.today.e5, e5Before: avg(e.before.e5), e4: e.today.e4, e4Before: avg(e.before.e4),
    firstErrorHour: firstBadHour(e.hoursToday, e.hoursBefore.map(avg)),
    hourly5xx: e.hoursToday,
    peakRps: Math.max(0, ...e.callsHourToday) / 3600,
  }));
  const ratio = (/** @type {number} */ a, /** @type {number} */ b) => (a + 1) / (b + 1);
  const errorsUp = list.filter((x) => x.e5 - x.e5Before >= 10 && ratio(x.e5, x.e5Before) >= 3).sort((a, b) => (b.e5 - b.e5Before) - (a.e5 - a.e5Before));
  const clientErrorsUp = list.filter((x) => x.e4 - x.e4Before >= 50 && ratio(x.e4, x.e4Before) >= 2).sort((a, b) => (b.e4 - b.e4Before) - (a.e4 - a.e4Before));
  const callsUp = list.filter((x) => Math.max(x.calls, x.callsBefore) >= min && x.callsBefore > 0 && x.calls / x.callsBefore >= 1.5).sort((a, b) => b.calls / b.callsBefore - a.calls / a.callsBefore);
  const callsDown = list.filter((x) => Math.max(x.calls, x.callsBefore) >= min && x.calls / Math.max(x.callsBefore, 1) <= 0.67).sort((a, b) => a.calls / Math.max(a.callsBefore, 1) - b.calls / Math.max(b.callsBefore, 1));
  const appeared = list.filter((x) => x.calls >= 20 && x.callsBefore === 0).sort((a, b) => b.calls - a.calls);
  const vanished = list.filter((x) => x.calls === 0 && x.callsBefore >= 20).sort((a, b) => b.callsBefore - a.callsBefore);
  // calls and 5xx up together: more load on an endpoint that now fails (retries, a client loop, an exhausted pool)
  const loadAndErrors = errorsUp.filter((x) => x.callsBefore > 0 && x.calls / x.callsBefore >= 1.3);
  const peak = (/** @type {'today'|'before'} */ k) => perHour.reduce((b, x, h) => (x[k] > b.calls ? { hour: h, calls: x[k] } : b), { hour: 0, calls: 0 });
  const pT = peak('today'), pB = peak('before');
  const load = { peakHour: pT.hour, peakRps: pT.calls / 3600, peakHourBefore: pB.hour, peakRpsBefore: pB.calls / nPrev / 3600 };
  const tot = perHour.reduce((a, x) => ({ today: a.today + x.today, before: a.before + x.before, today5: a.today5 + x.today5, before5: a.before5 + x.before5 }), { today: 0, before: 0, today5: 0, before5: 0 });
  return {
    today, upToHour: upTo, previousDays: prevDays,
    totals: { calls: tot.today, callsBefore: avg(tot.before), e5: tot.today5, e5Before: avg(tot.before5) },
    perHour: perHour.map((x, h) => ({ hour: h, calls: x.today, callsBefore: avg(x.before), e5: x.today5, e5Before: avg(x.before5) })),
    load, errorsUp, clientErrorsUp, loadAndErrors, callsUp, callsDown, appeared, vanished,
    note: `Today 00:00–${String(upTo).padStart(2, '0')}:59 UTC against the same hours on ${prevDays.join(', ') || 'no previous day'} (average).`,
  };
}

/** @typedef {{ calls: number, e5: number, e4: number }} Agg */
function agg() { return { calls: 0, e5: 0, e4: 0 }; }

/** First hour where 5xx jump: ≥ 10 and ≥ 5 × the same hour before. @param {number[]} today @param {number[]} before */
function firstBadHour(today, before) {
  const i = today.findIndex((n, h) => n >= 10 && n >= 5 * (before[h] || 0) + 5);
  return i < 0 ? null : i;
}

/** @param {string} day @param {number} n */
function shift(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
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
