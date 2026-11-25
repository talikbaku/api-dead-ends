// @ts-check
// Path templating: no scheme, host, query or fragment; identifier segments → {id}.
// The same logic is mirrored in the Painless script of the Elasticsearch adapter (src/adapters/elasticsearch.mjs).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * @param {string} seg
 * @returns {boolean}
 */
export function isIdSegment(seg) {
  if (!seg) return false;
  if (/^\d+$/.test(seg)) return true;
  if (UUID.test(seg) || ULID.test(seg)) return true;
  if (HEX.test(seg) && /\d/.test(seg)) return true;
  if (seg.includes('@')) return true;
  if (/\d/.test(seg) && seg.length >= 6) return true;
  if (isTokenLike(seg)) return true;
  return false;
}

/**
 * Secrets and opaque tokens without digits: known key prefixes, or long mixed-case strings
 * with many case switches (AbCdEfGhIjKl). Words like "getUserById" have few switches and stay.
 * @param {string} seg
 */
export function isTokenLike(seg) {
  if (/^(sk|pk|rk)_(live|test)_|^(ghp|gho|ghu|ghs|github_pat|glpat|xox[abpr]|AKIA|ASIA|AIza|ya29|eyJ)[A-Za-z0-9_-]/.test(seg)) return true;
  if (seg.length >= 10 && /^[A-Za-z0-9_-]+$/.test(seg) && /[A-Z]/.test(seg) && /[a-z]/.test(seg)) {
    const switches = (seg.match(/[a-z][A-Z]|[A-Z][a-z]/g) || []).length;
    if (switches >= Math.max(4, seg.length / 3)) return true;
  }
  return seg.length >= 32 && /^[A-Za-z0-9_-]+$/.test(seg);
}

/**
 * Drops scheme, host, query, fragment; collapses double slashes; drops the trailing slash.
 * @param {string} raw
 */
export function stripUrl(raw) {
  let u = String(raw ?? '').trim();
  const q = u.search(/[?#;]|%3[Ff]|%23/); // also encoded ?/# and ;jsessionid-style matrix params
  if (q >= 0) u = u.slice(0, q);
  const sch = u.indexOf('://');
  if (sch >= 0) {
    const sl = u.indexOf('/', sch + 3);
    u = sl < 0 ? '/' : u.slice(sl);
  }
  if (!u.startsWith('/')) u = `/${u}`;
  u = u.replace(/\/{2,}/g, '/');
  if (u.length > 1 && u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

/**
 * @param {string} raw
 * @param {{ maxLength?: number, keep?: Set<string> }} [opt]  keep — literal spec segments (spec first)
 */
export function templatePath(raw, opt = {}) {
  const max = opt.maxLength ?? 200;
  const keep = opt.keep;
  const p = stripUrl(raw)
    .split('/')
    .map((s) => (keep?.has(s) || !isIdSegment(safeDecode(s)) ? s : '{id}'))
    .join('/');
  return p.length > max ? p.slice(0, max) : p;
}

/** @param {string} s */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
