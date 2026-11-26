// "What changed": today vs the same hours on previous days, first error hour, peak load, calls+5xx together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChanges, hourLabel } from '../src/changes.mjs';

const NOW = Date.parse('2026-03-10T06:20:00Z'); // full hours today: 00..05
const row = (day, h, method, path, calls, status) => ({ method, path, calls, status: new Map(Object.entries(status)), first_seen: '', last_seen: '', day, hour: `${day}T${String(h).padStart(2, '0')}` });

function data() {
  const rows = [];
  for (const day of ['2026-03-08', '2026-03-09', '2026-03-10']) {
    for (let h = 0; h <= 6; h++) {
      const today = day === '2026-03-10';
      rows.push(row(day, h, 'GET', '/a', 3600, { 200: 3600 }));
      // /pay: from 03:00 today twice the calls and many 5xx
      const bad = today && h >= 3;
      rows.push(row(day, h, 'POST', '/pay', bad ? 200 : 100, bad ? { 200: 150, 500: 50 } : { 200: 100 }));
      if (today && h === 1) rows.push(row(day, h, 'GET', '/new', 30, { 200: 30 }));
    }
  }
  return rows;
}

test('what changed: totals, the hour errors started, peak load, calls and 5xx together', () => {
  const c = computeChanges(data(), { ops: [] }, { now: NOW });
  assert.equal(c.today, '2026-03-10');
  assert.equal(c.upToHour, 5); // the current hour (06) is still filling up
  assert.deepEqual(c.previousDays, ['2026-03-09', '2026-03-08']);
  assert.equal(c.totals.e5, 150);
  assert.equal(c.errorsUp[0].path, '/pay');
  assert.equal(c.errorsUp[0].firstErrorHour, 3);
  assert.equal(c.loadAndErrors.length, 1);
  assert.equal(c.load.peakHour >= 3, true);
  assert.equal(Math.round(c.load.peakRps * 3600), 3600 + 200);
  assert.equal(c.appeared[0].path, '/new');
  assert.equal(c.errorsUp[0].peakRps, 200 / 3600);
});

test('what changed: the last hour of an export made mid-hour is not compared', () => {
  const rows = data().filter((r) => r.hour !== '2026-03-10T06').map((r) => ({ ...r, last_seen: `${r.hour}:59:59.900Z` }));
  for (const r of rows) if (r.hour === '2026-03-10T05') r.last_seen = '2026-03-10T05:40:00.000Z';
  const c = computeChanges(rows, { ops: [] }, { now: Date.parse('2026-03-10T09:00:00Z') });
  assert.equal(c.upToHour, 4);
});

test('what changed: nothing without hourly rows; hour labels with a time zone', () => {
  assert.equal(computeChanges([{ method: 'GET', path: '/a', calls: 1, status: new Map() }], { ops: [] }), null);
  assert.equal(hourLabel('2026-01-15', 9), '09:00 UTC');
  assert.equal(hourLabel('2026-01-15', 9, 'America/New_York'), '09:00 UTC (04:00 EST)');
  assert.equal(hourLabel('2026-01-15', 9, 'Not/AZone'), '09:00 UTC');
});
