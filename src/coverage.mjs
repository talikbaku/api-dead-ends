// @ts-check
// "Not logged": compare two traffic sources for the same service.
// The reference (ingress / load balancer / APM) sees every request; the checked source (application logs)
// should see them too. Endpoints present in the reference but missing — or far fewer — in the checked
// source are probably not logged there (or sampled).

import { matchOp } from './spec.mjs';

/**
 * @param {import('./usage.mjs').UsageRow[]} checked   e.g. application logs
 * @param {import('./usage.mjs').UsageRow[]} reference e.g. ingress access logs or APM
 * @param {{ ops: any[] } | null} spec  when given, both sides are grouped by spec operation
 * @param {{ ratio?: number, min?: number }} [opt]  flag when checked < ratio × reference (default 0.5) and reference ≥ min calls (default 20)
 */
export function coverage(checked, reference, spec, opt = {}) {
  const ratio = opt.ratio ?? 0.5;
  const min = opt.min ?? 20;
  const keyOf = (/** @type {any} */ r) => {
    const op = spec ? matchOp(spec.ops, r.method, r.path) : null;
    return op ? `${op.method} ${op.path}` : `${r.method} ${r.path}`;
  };
  /** @type {Map<string, { method: string, path: string, reference: number, checked: number }>} */
  const by = new Map();
  const add = (/** @type {any[]} */ rows, /** @type {'reference'|'checked'} */ side) => {
    for (const r of rows) {
      const k = keyOf(r);
      const [method, ...p] = k.split(' ');
      const e = by.get(k) || { method, path: p.join(' '), reference: 0, checked: 0 };
      e[side] += r.calls;
      by.set(k, e);
    }
  };
  add(reference, 'reference');
  add(checked, 'checked');
  // A side without methods (ANY) is compared by path: fold same-path entries into the ANY entry.
  for (const [k, e] of [...by]) {
    if (e.method !== 'ANY') continue;
    for (const [k2, e2] of [...by]) if (k2 !== k && e2.path === e.path) { e.reference += e2.reference; e.checked += e2.checked; by.delete(k2); }
  }
  const all = [...by.values()];
  const refTotal = all.reduce((a, x) => a + x.reference, 0);
  const chkTotal = all.reduce((a, x) => a + x.checked, 0);
  const notLogged = all.filter((x) => x.reference >= min && x.checked === 0).sort((a, b) => b.reference - a.reference);
  const underLogged = all.filter((x) => x.reference >= min && x.checked > 0 && x.checked < ratio * x.reference)
    .map((x) => ({ ...x, share: x.checked / x.reference })).sort((a, b) => a.share - b.share);
  return {
    totals: { reference: refTotal, checked: chkTotal, overall: refTotal ? chkTotal / refTotal : 0 },
    thresholds: { ratio, min },
    notLogged,
    underLogged,
    note: 'Both sources must cover the same period. A lower count can also mean sampling, or traffic answered before it reaches the application (cache, auth at the gateway).',
  };
}

/** @param {ReturnType<typeof coverage>} c */
export function coverageToMarkdown(c) {
  const n = (/** @type {number} */ x) => x.toLocaleString('en-US');
  const code = (/** @type {string} */ s) => `\`${String(s).replace(/[\u0000-\u001f`|]/g, ' ')}\``;
  const L = ['# api-dead-ends: logging coverage', '',
    `Reference: ${n(c.totals.reference)} requests · checked source: ${n(c.totals.checked)} (${(c.totals.overall * 100).toFixed(1)}%). ${c.note}`, ''];
  L.push('## Not logged: in the reference, absent from the checked source', '');
  if (!c.notLogged.length) L.push('_None._', '');
  else { L.push('| Method | Path | Reference calls |', '|---|---|---:|'); for (const x of c.notLogged) L.push(`| ${x.method} | ${code(x.path)} | ${n(x.reference)} |`); L.push(''); }
  L.push(`## Under-logged: checked < ${c.thresholds.ratio * 100}% of the reference`, '');
  if (!c.underLogged.length) L.push('_None._', '');
  else { L.push('| Method | Path | Reference | Checked | Share |', '|---|---|---:|---:|---:|'); for (const x of c.underLogged) L.push(`| ${x.method} | ${code(x.path)} | ${n(x.reference)} | ${n(x.checked)} | ${(x.share * 100).toFixed(1)}% |`); L.push(''); }
  return L.join('\n');
}
