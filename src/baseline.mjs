// @ts-check
// CI baseline: known shadow endpoints. CI fails only on new ones.

/** @param {ReturnType<typeof import('./classify.mjs').classify>} r */
export function makeBaseline(r) {
  return {
    schemaVersion: 1,
    shadow: r.shadow.map((s) => `${s.method} ${s.path}`).sort(),
    deprecatedInUse: r.endpoints.filter((e) => e.class === 'deprecated_in_use').map((e) => ({ key: `${e.method} ${e.path}`, calls: e.calls })),
  };
}

/**
 * @param {ReturnType<typeof import('./classify.mjs').classify>} r
 * @param {any} base
 * @param {{ failOn?: string[] }} [opt]
 */
export function compareBaseline(r, base, opt = {}) {
  const failOn = new Set(opt.failOn ?? ['new-shadow']);
  const known = new Set(base?.shadow ?? []);
  const newShadow = r.shadow.filter((s) => !known.has(`${s.method} ${s.path}`));
  const prevDep = new Map((base?.deprecatedInUse ?? []).map((/** @type {any} */ d) => [d.key, d.calls]));
  const depGrowth = r.endpoints
    .filter((e) => e.class === 'deprecated_in_use')
    .filter((e) => e.calls > (prevDep.get(`${e.method} ${e.path}`) ?? 0));
  const fail = (failOn.has('new-shadow') && newShadow.length > 0) || (failOn.has('deprecated-growth') && depGrowth.length > 0);
  return { fail, newShadow, depGrowth };
}
