// @ts-check
// A small, dependency-free YAML reader for OpenAPI / Swagger files (a strict subset of YAML 1.2).
//
// Supported: block mappings and sequences (also `- key: v` items and sequences at the same indent as
// their key), plain / 'single' / "double" quoted scalars (all YAML escapes) incl. multi-line ones,
// comments, flow collections ([a, b], {a: 1}, [], {} — also across lines), block scalars | and >
// with chomping (- +) and indentation indicators, YAML 1.2 core schema (null, booleans, ints incl.
// 0x/0o, floats, .inf, .nan), multi-document streams (the first document is used), `...`, %
// directives, anchors and aliases (&a / *a) and merge keys (<<) — aliases are shared, not copied, and
// their total expansion is capped in nodes and characters and may not nest deeper than MAX_DEPTH
// (billion-laughs protection), explicit `? key` / `: value` entries
// whose key is a scalar (PyYAML writes keys longer than 128 characters this way), the core tags
// !!str (forces a string) and !!int / !!float / !!bool / !!null (applied; a value that does not fit
// the tag is an error, also a collection), !!map / !!seq (checked: only on a mapping / a sequence or an
// empty value), !!binary / !!timestamp (ignored).
// Refused with an error: complex keys (a collection as a key), custom tags (!foo), duplicate keys,
// tab indentation, the key __proto__, nesting deeper than MAX_DEPTH, input larger than MAX_YAML_CHARS.
// Mapping keys are always strings from the source text (`200:` → "200"); values follow the core schema.
// Every key is stored as an own data property (like JSON.parse), so `constructor` / `prototype` keys
// are harmless; nothing is ever assigned through the prototype chain. No eval, no regex backtracking.
// Error messages are fixed phrases plus a line number: they never contain file content.

/** Same cap as the MCP server's input files. */
export const MAX_YAML_CHARS = 200 * 1024 * 1024;
/** Nesting depth (block + flow). Real OpenAPI files stay far below this. */
export const MAX_DEPTH = 256;
/** Total nodes that aliases may expand to (each *alias counts the whole subtree it points to). */
export const MAX_ALIAS_EXPANSION = 1000000;
/** Total characters (keys + strings) that aliases and merge keys may copy by reference. */
export const MAX_ALIAS_CHARS = 16 * 1024 * 1024;

const CORE_TAGS = new Set(['!!str', '!!int', '!!float', '!!bool', '!!null', '!!map', '!!seq', '!!binary', '!!timestamp']);
const TYPED_TAGS = new Set(['!!str', '!!int', '!!float', '!!bool', '!!null']);
const FLOW_IND = new Set([',', '[', ']', '{', '}']);

export class YamlError extends Error {
  /** @param {string} msg @param {number} line */
  constructor(msg, line) {
    super(`YAML: ${msg} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

/** @param {any} obj @param {string} key @param {any} value */
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** @param {string} c */
const isWs = (c) => c === ' ' || c === '\t';
/** @param {string | undefined} c */
const isBreak = (c) => c === '\n' || c === undefined;
/** @param {string | undefined} c */
const isWsOrEnd = (c) => c === ' ' || c === '\t' || c === '\n' || c === undefined;

/**
 * Resolve a plain scalar with the YAML 1.2 core schema.
 * @param {string} s
 */
export function resolvePlain(s) {
  switch (s) {
    case '': case '~': case 'null': case 'Null': case 'NULL': return null;
    case 'true': case 'True': case 'TRUE': return true;
    case 'false': case 'False': case 'FALSE': return false;
    case '.inf': case '.Inf': case '.INF': case '+.inf': case '+.Inf': case '+.INF': return Infinity;
    case '-.inf': case '-.Inf': case '-.INF': return -Infinity;
    case '.nan': case '.NaN': case '.NAN': return NaN;
  }
  const c = s.charCodeAt(0);
  // numbers start with a digit, sign or dot; anything else is a string (fast path)
  if (!((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) || s.length > 64) return s;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  return s;
}

const ESC = /** @type {Record<string, string>} */ ({
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ',
  '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ',
});

class Parser {
  /** @param {string} src */
  constructor(src) {
    this.s = src;
    this.pos = 0;
    this.depth = 0;
    this.expanded = 0;
    this.expandedChars = 0;
    /** @type {WeakMap<object, { chars: number, depth: number }>} */
    this.meta = new WeakMap();
    /** @type {Map<string, { value: any, size: number }>} */
    this.anchors = new Map();
    /** sizes of collections (node counts incl. alias expansion) */
    /** @type {WeakMap<object, number>} */
    this.sizes = new WeakMap();
    /** source text of the last plain scalar (for keys and !!str) @type {string | undefined} */
    this.lastPlain = undefined;
    this.lastKeyQuoted = false;
    this.tagAt = 0;
    /** last nextContent() result: from → to, column (so callers that step back do not rescan) */
    this.skipFrom = -1;
    this.skipTo = -1;
    this.skipCol = -1;
  }

  /** @param {string} msg @param {number} [at] */
  fail(msg, at = this.pos) {
    let line = 1;
    const end = Math.min(at, this.s.length);
    for (let i = this.s.indexOf('\n'); i !== -1 && i < end; i = this.s.indexOf('\n', i + 1)) line++;
    return new YamlError(msg, line);
  }

  enter() { if (++this.depth > MAX_DEPTH) throw this.fail('nesting is too deep'); }
  leave() { this.depth--; }

  /** column of position p (characters since the last line break) */
  col(p = this.pos) {
    const nl = this.s.lastIndexOf('\n', p - 1);
    return p - nl - 1;
  }

  /** Characters and nesting depth of a value (each object walked once). @param {any} v @returns {{ chars: number, depth: number }} */
  measure(v) {
    if (typeof v === 'string') return { chars: v.length, depth: 0 };
    if (v === null || typeof v !== 'object') return { chars: 0, depth: 0 };
    let m = this.meta.get(v);
    if (m) return m;
    m = { chars: 0, depth: 1 };
    for (const k of Object.keys(v)) { const c = this.measure(v[k]); m.chars += k.length + c.chars; if (c.depth + 1 > m.depth) m.depth = c.depth + 1; }
    this.meta.set(v, m);
    return m;
  }

  /** @param {any} v */
  size(v) { return v !== null && typeof v === 'object' ? (this.sizes.get(v) || 1) : 1; }

  /** Skip spaces/tabs on the current line. */
  skipSpaces() { while (isWs(this.s[this.pos])) this.pos++; }

  /** Skip to the end of the line if the rest is blank or a comment. Returns false if other content follows. */
  restOfLineEmpty() {
    this.skipSpaces();
    const c = this.s[this.pos];
    if (c === '#') { const e = this.s.indexOf('\n', this.pos); this.pos = e === -1 ? this.s.length : e; return true; }
    return isBreak(c);
  }

  /**
   * Move to the first content character of the next non-blank, non-comment line (or EOF).
   * Tabs in indentation are refused. Returns the column of that character, or -1 at EOF.
   */
  nextContent() {
    if (this.pos === this.skipFrom) { this.pos = this.skipTo; return this.skipCol; }
    const from = this.pos;
    const col = this.scanContent();
    this.skipFrom = from;
    this.skipTo = this.pos;
    this.skipCol = col;
    return col;
  }

  scanContent() {
    const s = this.s;
    for (;;) {
      if (this.pos >= s.length) return -1;
      while (s[this.pos] === ' ') this.pos++;
      const c = s[this.pos];
      if (c === '\t') {
        // a tab right after the indentation is fine only if the line is blank or a comment
        let p = this.pos;
        while (isWs(s[p])) p++;
        if (s[p] === '#' || isBreak(s[p])) { this.pos = p; }
        else throw this.fail('tabs are not allowed for indentation');
      }
      const d = s[this.pos];
      if (d === '#') { const e = s.indexOf('\n', this.pos); this.pos = e === -1 ? s.length : e; }
      if (s[this.pos] === '\n') { this.pos++; continue; }
      if (this.pos >= s.length) return -1;
      return this.col();
    }
  }

  /** `---` or `...` at column 0 followed by whitespace or end of input */
  atDocMarker(p = this.pos) {
    const s = this.s;
    if (p !== 0 && s[p - 1] !== '\n') return false;
    const t = s.slice(p, p + 3);
    return (t === '---' || t === '...') && isWsOrEnd(s[p + 3]);
  }

  parseStream() {
    const s = this.s;
    // directives and the document start marker
    for (;;) {
      const c = this.nextContent();
      if (c === -1) return null;
      if (c === 0 && s[this.pos] === '%') { const e = s.indexOf('\n', this.pos); this.pos = e === -1 ? s.length : e; continue; }
      break;
    }
    if (this.atDocMarker() && s[this.pos] === '-') {
      this.pos += 3;
      if (!this.restOfLineEmpty()) {
        // `--- value` on the marker line
        this.skipSpaces();
        const v = this.parseInlineNode(-1);
        this.expectDocEnd();
        return v;
      }
    } else if (this.atDocMarker()) return null; // `...` before any content
    const v = this.parseBlockNode(-1, false);
    this.expectDocEnd();
    return v;
  }

  expectDocEnd() {
    const c = this.nextContent();
    if (c === -1 || this.atDocMarker()) return;
    throw this.fail('unexpected content (check the indentation)');
  }

  /**
   * Parse a node that starts on a following line (or at the current position if it is at a line's content).
   * @param {number} parent indentation of the parent collection (-1 at top level)
   * @param {boolean} seqAtParent a block sequence may sit at the parent's own indentation (mapping values)
   */
  parseBlockNode(parent, seqAtParent) {
    const save = this.pos;
    const c = this.nextContent();
    if (c === -1 || this.atDocMarker()) { this.pos = c === -1 ? this.pos : save; return null; }
    if (c > parent || (seqAtParent && c === parent && this.s[this.pos] === '-' && isWsOrEnd(this.s[this.pos + 1]))) {
      return this.parseNodeAt(c, parent);
    }
    this.pos = save;
    return null;
  }

  /**
   * Node whose first character is at this.pos, at column `indent`, inside a parent at `parent`.
   * @param {number} indent @param {number} parent
   */
  parseNodeAt(indent, parent) {
    const s = this.s;
    const props = this.parseProps();
    if (props.anchor !== null || props.tag !== null) {
      if (this.restOfLineEmpty()) {
        // properties alone on the line: the node follows on the next lines
        this.enter();
        const v = this.parseBlockNode(parent, true);
        this.leave();
        return this.finishProps(props, v);
      }
      this.skipSpaces();
      indent = this.col();
    }
    const c = s[this.pos];
    let v;
    if (c === '-' && isWsOrEnd(s[this.pos + 1])) v = this.parseBlockSeq(indent);
    else if (this.isKeyAhead()) v = this.parseBlockMap(indent);
    else v = this.parseInlineNode(parent);
    return this.finishProps(props, v);
  }

  /** @returns {{ anchor: string | null, tag: string | null, tagAt: number }} */
  parseProps() {
    const s = this.s;
    /** @type {string | null} */ let anchor = null;
    /** @type {string | null} */ let tag = null;
    let tagAt = this.pos;
    for (;;) {
      const c = s[this.pos];
      if (c === '&' && anchor === null) {
        const start = ++this.pos;
        while (!isWsOrEnd(s[this.pos]) && !FLOW_IND.has(s[this.pos])) this.pos++;
        if (this.pos === start) throw this.fail('empty anchor name');
        anchor = s.slice(start, this.pos);
      } else if (c === '!' && tag === null) {
        const start = this.pos;
        while (!isWsOrEnd(s[this.pos]) && !FLOW_IND.has(s[this.pos])) this.pos++;
        tag = s.slice(start, this.pos);
        if (!CORE_TAGS.has(tag)) throw this.fail('custom tags are not supported (only the !! core tags)', start);
        this.lastPlain = undefined; // the tagged node sets it again if it is a plain scalar
        this.tagAt = start;
        tagAt = start;
      } else break;
      this.skipSpaces();
    }
    return { anchor, tag, tagAt };
  }

  /** @param {{ anchor: string | null, tag: string | null, tagAt?: number }} props @param {any} v */
  finishProps(props, v) {
    const tag = props.tag;
    if (tag !== null) {
      const at = props.tagAt ?? this.tagAt;
      const coll = v !== null && typeof v === 'object';
      if (TYPED_TAGS.has(tag) && coll) throw this.fail(`a ${tag} tag cannot be on a ${Array.isArray(v) ? 'sequence' : 'mapping'}`, at);
      if (tag === '!!map' && (Array.isArray(v) || (!coll && v !== null))) throw this.fail(`the value does not match its !!map tag`, at);
      if (tag === '!!seq' && ((coll && !Array.isArray(v)) || (!coll && v !== null))) throw this.fail(`the value does not match its !!seq tag`, at);
      if (TYPED_TAGS.has(tag)) {
        const text = typeof v === 'string' ? v : this.lastPlain ?? (v === null ? '' : String(v));
        this.tagAt = at;
        v = this.applyTag(tag, text);
      }
    }
    if (props.anchor !== null) this.anchors.set(props.anchor, { value: v, size: this.size(v), ...this.measure(v) });
    return v;
  }

  /**
   * Value of a scalar with a core tag, from its text. A value that does not fit the tag is refused.
   * @param {string} tag @param {string} text
   */
  applyTag(tag, text) {
    if (tag === '!!str') return text;
    const r = resolvePlain(text);
    if (tag === '!!null' ? r === null
      : tag === '!!bool' ? typeof r === 'boolean'
      : tag === '!!int' ? typeof r === 'number' && /^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/.test(text)
      : typeof r === 'number') return r;
    throw this.fail(`the value does not match its ${tag} tag`, this.tagAt);
  }

  /**
   * Is there an implicit mapping key at this.pos (`key:` followed by space / end of line, on this line)?
   */
  isKeyAhead() {
    const s = this.s;
    let p = this.pos;
    const c = s[p];
    if (c === '"' || c === "'") {
      p++;
      for (;;) {
        const d = s[p];
        if (d === undefined || d === '\n') return false; // multi-line quoted keys are not keys here
        if (c === "'" && d === "'") { if (s[p + 1] === "'") { p += 2; continue; } p++; break; }
        if (c === '"' && d === '\\') { p += 2; continue; }
        if (c === '"' && d === '"') { p++; break; }
        p++;
      }
      while (isWs(s[p])) p++;
      return s[p] === ':' && isWsOrEnd(s[p + 1]);
    }
    if (c === '?' && isWsOrEnd(s[p + 1])) return true; // explicit `? key`
    if (c === '[' || c === '{') return false;
    if (c === '*' || c === '|' || c === '>' || c === '#') return false;
    for (; ; p++) {
      const d = s[p];
      if (d === undefined || d === '\n') return false;
      if (d === ':' && isWsOrEnd(s[p + 1])) return true;
      if (d === '#' && isWs(s[p - 1])) return false;
    }
  }

  /** @param {number} indent */
  parseBlockSeq(indent) {
    const s = this.s;
    this.enter();
    const arr = [];
    let size = 1;
    for (;;) {
      // at '-'
      this.pos++;
      let item;
      if (this.restOfLineEmpty()) item = this.parseBlockNode(indent, false);
      else {
        this.skipSpaces();
        item = this.parseNodeAt(this.col(), indent);
      }
      arr.push(item);
      size += this.size(item);
      const save = this.pos;
      const c = this.nextContent();
      if (c === indent && !this.atDocMarker() && s[this.pos] === '-' && isWsOrEnd(s[this.pos + 1])) continue;
      if (c > indent && !this.atDocMarker()) throw this.fail('bad indentation of a sequence entry');
      this.pos = save;
      break;
    }
    this.sizes.set(arr, size);
    this.leave();
    return arr;
  }

  /** @param {number} indent */
  parseBlockMap(indent) {
    const s = this.s;
    this.enter();
    /** @type {Record<string, any>} */
    const obj = {};
    /** @type {any[]} */
    const merges = [];
    let size = 1;
    for (;;) {
      const keyAt = this.pos;
      if (!this.isKeyAhead()) throw this.fail('expected a "key: value" entry');
      let value;
      let key;
      if (s[this.pos] === '?' && isWsOrEnd(s[this.pos + 1])) {
        key = this.parseExplicitKey(indent);
        // `: value` at the same indent; without it the value is null
        const save = this.pos;
        const c = this.nextContent();
        if (c === indent && s[this.pos] === ':' && isWsOrEnd(s[this.pos + 1])) {
          this.pos++;
          if (this.restOfLineEmpty()) value = this.parseBlockNode(indent, true);
          else { this.skipSpaces(); value = this.parseNodeAt(this.col(), indent); } // `: type: object` is fine here
        } else {
          if (c > indent && !this.atDocMarker()) throw this.fail('complex keys (? ) are not supported');
          this.pos = save;
          value = null;
        }
      } else {
        key = this.parseKey();
        this.skipSpaces();
        this.pos++; // ':'
        value = this.parseImplicitValue(indent);
      }
      if (key === '<<' && !this.lastKeyQuoted) merges.push({ value, at: keyAt });
      else this.setKey(obj, key, value, keyAt);
      size += 1 + this.size(value);
      const save = this.pos;
      const c = this.nextContent();
      if (c === indent && !this.atDocMarker()) continue;
      if (c > indent && !this.atDocMarker()) throw this.fail('bad indentation of a mapping entry');
      this.pos = save;
      break;
    }
    size += this.applyMerges(obj, merges);
    this.sizes.set(obj, size);
    this.leave();
    return obj;
  }

  /** Value after `key:` in a block mapping at `indent`. @param {number} indent */
  parseImplicitValue(indent) {
    if (this.restOfLineEmpty()) return this.parseBlockNode(indent, true);
    this.skipSpaces();
    const props = this.parseProps();
    if ((props.anchor !== null || props.tag !== null) && this.restOfLineEmpty()) {
      this.enter();
      const v = this.finishProps(props, this.parseBlockNode(indent, true));
      this.leave();
      return v;
    }
    this.skipSpaces();
    if (this.isKeyAhead()) throw this.fail('a mapping cannot start on the same line as its key');
    return this.finishProps(props, this.parseInlineNode(indent));
  }

  /** @param {Record<string, any>} obj @param {string} key @param {any} value @param {number} at */
  setKey(obj, key, value, at) {
    if (key === '__proto__') throw this.fail('the key __proto__ is not allowed', at);
    if (Object.hasOwn(obj, key)) throw this.fail('duplicate key', at);
    put(obj, key, value);
  }

  /** @param {Record<string, any>} obj @param {{ value: any, at: number }[]} merges */
  applyMerges(obj, merges) {
    let added = 0;
    for (const m of merges) {
      const sources = Array.isArray(m.value) ? m.value : [m.value];
      for (const src of sources) {
        if (!src || typeof src !== 'object' || Array.isArray(src)) throw this.fail('merge key << needs a mapping or a list of mappings', m.at);
        for (const k of Object.keys(src)) {
          if (Object.hasOwn(obj, k)) continue; // explicit keys and earlier merges win
          put(obj, k, src[k]);
          added += 1 + this.size(src[k]);
          this.countExpansion(1 + this.size(src[k]), m.at, k.length + this.measure(src[k]).chars);
        }
      }
    }
    return added;
  }

  /** @param {number} n @param {number} at @param {number} [chars] */
  countExpansion(n, at, chars = 0) {
    this.expanded += n;
    this.expandedChars += chars;
    if (this.expanded > MAX_ALIAS_EXPANSION || this.expandedChars > MAX_ALIAS_CHARS) throw this.fail('aliases expand to too many nodes (possible alias bomb)', at);
  }

  /**
   * `? key` in a block mapping: only a scalar key (plain, may continue on more-indented lines, or quoted).
   * Leaves the position after the key. @param {number} indent
   */
  parseExplicitKey(indent) {
    const s = this.s;
    const at = this.pos;
    this.pos++; // '?'
    this.lastKeyQuoted = false;
    if (this.restOfLineEmpty()) throw this.fail('complex keys (? ) are not supported', at);
    this.skipSpaces();
    const c = s[this.pos];
    if (c === '[' || c === '{' || c === '&' || c === '!' || c === '*' || c === '|' || c === '>' || c === '@' || c === '`'
      || ((c === '-' || c === '?' || c === ':') && isWsOrEnd(s[this.pos + 1])) || this.isKeyAhead()) {
      throw this.fail('complex keys (? ) are not supported', at);
    }
    if (c === '"' || c === "'") {
      this.lastKeyQuoted = true;
      const k = c === '"' ? this.parseDouble() : this.parseSingle();
      if (!this.restOfLineEmpty()) throw this.fail('unexpected content after a quoted scalar');
      return k;
    }
    this.parsePlainBlock(indent);
    return /** @type {string} */ (this.lastPlain);
  }

  parseKey() {
    const s = this.s;
    const c = s[this.pos];
    this.lastKeyQuoted = false;
    if (c === '"' || c === "'") { this.lastKeyQuoted = true; return c === '"' ? this.parseDouble() : this.parseSingle(); }
    const start = this.pos;
    let end = start;
    for (let p = start; ; p++) {
      const d = s[p];
      if (d === ':' && isWsOrEnd(s[p + 1])) { this.pos = p; break; }
      if (!isWs(d)) end = p + 1;
    }
    return s.slice(start, end);
  }

  /**
   * A node that starts on the current line: alias, flow collection, quoted, block scalar or plain scalar.
   * @param {number} parent indentation of the enclosing block collection
   */
  parseInlineNode(parent) {
    const s = this.s;
    const c = s[this.pos];
    this.lastPlain = undefined;
    if (c === '*') return this.parseAlias();
    if (c === '[' || c === '{') {
      const v = this.parseFlow();
      if (!this.restOfLineEmpty()) throw this.fail('unexpected content after a flow collection');
      return v;
    }
    if (c === '"' || c === "'") {
      const v = c === '"' ? this.parseDouble() : this.parseSingle();
      if (!this.restOfLineEmpty()) throw this.fail('unexpected content after a quoted scalar');
      return v;
    }
    if (c === '|' || c === '>') return this.parseBlockScalar(parent);
    if (c === '@' || c === '`') throw this.fail('a plain scalar cannot start with @ or `');
    return this.parsePlainBlock(parent);
  }

  parseAlias() {
    const s = this.s;
    const at = this.pos;
    const start = ++this.pos;
    while (!isWsOrEnd(s[this.pos]) && !FLOW_IND.has(s[this.pos])) this.pos++;
    const name = s.slice(start, this.pos);
    const a = this.anchors.get(name);
    if (!a) throw this.fail('unknown alias (or an alias inside its own anchor)', at);
    if (this.depth + a.depth > MAX_DEPTH) throw this.fail('nesting is too deep', at);
    this.countExpansion(a.size, at, a.chars);
    return a.value;
  }

  /** Plain scalar in block context; may continue on more-indented lines. @param {number} parent */
  parsePlainBlock(parent) {
    const s = this.s;
    let out = '';
    for (;;) {
      // one line of the scalar
      const start = this.pos;
      let end = start;
      let p = start;
      for (; ; p++) {
        const d = s[p];
        if (d === undefined || d === '\n') break;
        if (d === '#' && isWs(s[p - 1])) break;
        if (d === ':' && isWsOrEnd(s[p + 1])) throw this.fail('unexpected ": " in a plain value (quote it)');
        if (!isWs(d)) end = p + 1;
      }
      out += s.slice(start, end);
      this.pos = p;
      if (s[p] === '#') { const e = s.indexOf('\n', p); this.pos = e === -1 ? s.length : e; break; }
      // continuation lines: more indented than the parent, not a comment, not a document marker
      const save = this.pos;
      let breaks = 0;
      let q = this.pos;
      while (s[q] === '\n') {
        q++; breaks++;
        let r = q;
        while (isWs(s[r])) r++;
        if (s[r] === '\n') { q = r; continue; }
        q = r;
        break;
      }
      if (breaks === 0 || q >= s.length) { this.pos = save; break; }
      const col = this.col(q);
      // indentation is spaces only; tabs may follow it (s-flow-line-prefix)
      let sp = 0;
      while (s[q - col + sp] === ' ') sp++;
      if (sp <= parent && sp < col && s[q] !== '#') throw this.fail('tabs are not allowed for indentation', q);
      if (sp <= parent || s[q] === '#' || (col === 0 && this.atDocMarker(q))) { this.pos = save; break; }
      out += breaks === 1 ? ' ' : '\n'.repeat(breaks - 1);
      this.pos = q;
    }
    this.lastPlain = out;
    return resolvePlain(out);
  }

  /**
   * Line folding inside a quoted scalar: s[p] is a line break. One break becomes a space, n breaks n-1
   * newlines; indentation of the following lines is skipped. (Trailing spaces before the break were
   * already left out by the caller: see textEnd.)
   * @param {number} p @param {number} at start of the scalar @param {{ out: string }} st
   */
  foldBreak(p, at, st) {
    const s = this.s;
    let n = 0;
    while (s[p] === '\n') {
      n++; p++;
      if (this.atDocMarker(p)) throw this.fail('unterminated quoted string', at);
      while (isWs(s[p])) p++;
    }
    st.out += n === 1 ? ' ' : '\n'.repeat(n - 1);
    return p;
  }

  /** End of a run of literal text [p, q): spaces/tabs right before a line break are dropped. @param {number} p @param {number} q */
  textEnd(p, q) {
    if (this.s[q] !== '\n') return q;
    while (q > p && isWs(this.s[q - 1])) q--;
    return q;
  }

  parseSingle() {
    const s = this.s;
    const at = this.pos;
    let p = this.pos + 1;
    const st = { out: '' };
    for (;;) {
      const d = s[p];
      if (d === undefined) throw this.fail('unterminated quoted string', at);
      if (d === "'") {
        if (s[p + 1] === "'") { st.out += "'"; p += 2; continue; }
        this.pos = p + 1;
        return st.out;
      }
      if (d === '\n') { p = this.foldBreak(p, at, st); continue; }
      let q = p + 1;
      while (q < s.length && s[q] !== "'" && s[q] !== '\n') q++;
      st.out += s.slice(p, this.textEnd(p, q));
      p = q;
    }
  }

  parseDouble() {
    const s = this.s;
    const at = this.pos;
    let p = this.pos + 1;
    const st = { out: '' };
    for (;;) {
      const d = s[p];
      if (d === undefined) throw this.fail('unterminated quoted string', at);
      if (d === '"') { this.pos = p + 1; return st.out; }
      if (d === '\n') { p = this.foldBreak(p, at, st); continue; }
      if (d === '\\') {
        const e = s[p + 1];
        if (e === '\n') {
          // escaped line break: join without a space, drop the next line's indentation
          p += 2;
          while (isWs(s[p])) p++;
          continue;
        }
        if (e === 'x' || e === 'u' || e === 'U') {
          const n = e === 'x' ? 2 : e === 'u' ? 4 : 8;
          const hex = s.slice(p + 2, p + 2 + n);
          if (hex.length !== n || !/^[0-9a-fA-F]+$/.test(hex)) throw this.fail('bad escape in a quoted string', p);
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff) throw this.fail('bad escape in a quoted string', p);
          st.out += String.fromCodePoint(cp);
          p += 2 + n;
        } else if (e !== undefined && Object.hasOwn(ESC, e)) { st.out += ESC[e]; p += 2; }
        else throw this.fail('bad escape in a quoted string', p);
        continue;
      }
      let q = p + 1;
      while (q < s.length && s[q] !== '"' && s[q] !== '\\' && s[q] !== '\n') q++;
      st.out += s.slice(p, this.textEnd(p, q));
      p = q;
    }
  }

  /** Block scalar | or >. @param {number} parent */
  parseBlockScalar(parent) {
    const s = this.s;
    const folded = s[this.pos] === '>';
    this.pos++;
    let chomp = 'clip';
    let explicit = 0;
    for (let i = 0; i < 2; i++) {
      const d = s[this.pos];
      if ((d === '-' || d === '+') && chomp === 'clip') { chomp = d === '-' ? 'strip' : 'keep'; this.pos++; }
      else if (d >= '1' && d <= '9' && !explicit) { explicit = Number(d); this.pos++; }
    }
    if (!isWsOrEnd(s[this.pos]) || !this.restOfLineEmpty()) throw this.fail('bad block scalar header');
    if (s[this.pos] === '\n') this.pos++;
    const base = Math.max(parent, 0);
    let indent = explicit ? (parent < 0 ? explicit : base + explicit) : -1;
    /** @type {string[]} */
    const lines = [];
    let maxLead = 0;
    for (;;) {
      if (this.pos >= s.length) break;
      const e0 = s.indexOf('\n', this.pos);
      const e = e0 === -1 ? s.length : e0;
      const line = s.slice(this.pos, e);
      let sp = 0;
      while (line[sp] === ' ') sp++;
      // a line of spaces only is empty; a tab after the indentation is content (l-nb-literal-text)
      if (sp === line.length && (indent === -1 || sp <= indent)) {
        if (indent === -1) maxLead = Math.max(maxLead, sp);
        lines.push('');
        this.pos = e0 === -1 ? s.length : e + 1;
        continue;
      }
      if (indent === -1) {
        if (sp <= parent) break;
        if (sp < maxLead) throw this.fail('leading blank lines are more indented than the block scalar');
        indent = sp;
      }
      if (sp < indent) break;
      if (sp === 0 && this.atDocMarker(this.pos)) break;
      lines.push(line.slice(indent));
      this.pos = e0 === -1 ? s.length : e + 1;
    }
    // leave the position at the start of the line that ended the scalar (or EOF)
    // trailing empty lines
    let trail = 0;
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); trail++; }
    let out = '';
    if (!folded) {
      out = lines.join('\n');
    } else {
      let prevMore = false;
      let empty = 0;
      let started = false;
      for (const l of lines) {
        if (l === '') { empty++; continue; }
        const more = l[0] === ' ' || l[0] === '\t';
        if (!started) out += '\n'.repeat(empty);
        else if (more || prevMore) out += '\n'.repeat(empty + 1);
        else out += empty ? '\n'.repeat(empty) : ' ';
        out += l;
        started = true;
        empty = 0;
        prevMore = more;
      }
    }
    const hasContent = lines.length > 0;
    if (chomp === 'keep') out += '\n'.repeat(hasContent ? trail + 1 : trail);
    else if (chomp === 'clip' && hasContent) out += '\n';
    // step back so the caller's nextContent() sees the terminating line from its start
    if (this.pos > 0 && this.pos <= s.length && s[this.pos - 1] === '\n') this.pos--;
    return out;
  }

  /** Flow collection [..] or {..}, may span lines. */
  parseFlow() {
    const s = this.s;
    const open = s[this.pos];
    const at = this.pos;
    this.enter();
    this.pos++;
    const isSeq = open === '[';
    const close = isSeq ? ']' : '}';
    /** @type {any} */
    const out = isSeq ? [] : {};
    /** @type {any[]} */
    const merges = [];
    let size = 1;
    for (;;) {
      this.skipFlowWs(at);
      if (s[this.pos] === close) { this.pos++; break; }
      // entry
      let explicit = false;
      if (s[this.pos] === '?' && (isWsOrEnd(s[this.pos + 1]) || FLOW_IND.has(s[this.pos + 1]))) {
        explicit = true; // `? key : value` — a collection key is still refused below
        this.pos++;
        this.skipFlowWs(at);
      }
      const keyAt = this.pos;
      this.lastPlain = undefined;
      const props = this.parseProps();
      this.skipFlowWs(at);
      let quoted = false;
      let k;
      const c = s[this.pos];
      if (c === '[' || c === '{') k = this.parseFlow();
      else if (c === '*') k = this.parseAlias();
      else if (c === '"' || c === "'") { quoted = true; k = c === '"' ? this.parseDouble() : this.parseSingle(); }
      else if (c === ',' || c === close) k = null;
      else k = this.parsePlainFlow(at);
      k = this.finishProps(props, k);
      const rawKey = this.lastPlain;
      this.skipFlowWs(at);
      // `:` after a quoted/JSON-like key may be adjacent; after a plain key it needs a following space
      let hasValue = false;
      if (s[this.pos] === ':' && (quoted || isWsOrEnd(s[this.pos + 1]) || FLOW_IND.has(s[this.pos + 1]))) { hasValue = true; this.pos++; }
      let v = null;
      if (hasValue) {
        this.skipFlowWs(at);
        if (s[this.pos] !== ',' && s[this.pos] !== close) v = this.parseFlowValue(at);
      }
      if (isSeq && !hasValue && !explicit) { out.push(k); size += this.size(k); }
      else {
        if (k !== null && typeof k === 'object') throw this.fail('complex keys are not supported', keyAt);
        const key = typeof k === 'string' ? k : rawKey !== undefined ? rawKey : String(k);
        if (isSeq) { const o = {}; this.setKey(o, key, v, keyAt); this.sizes.set(o, 2 + this.size(v)); out.push(o); size += 2 + this.size(v); }
        else {
          if (key === '<<' && !quoted) merges.push({ value: v, at: keyAt });
          else this.setKey(out, key, v, keyAt);
          size += 1 + this.size(v);
        }
      }
      this.skipFlowWs(at);
      if (s[this.pos] === ',') { this.pos++; continue; }
      if (s[this.pos] === close) { this.pos++; break; }
      throw this.fail(`expected , or ${close} in a flow collection`);
    }
    if (!isSeq) size += this.applyMerges(out, merges);
    this.sizes.set(out, size);
    this.leave();
    return out;
  }

  /** @param {number} at */
  parseFlowValue(at) {
    const s = this.s;
    const props = this.parseProps();
    this.skipFlowWs(at);
    const c = s[this.pos];
    let v;
    this.lastPlain = undefined;
    if (c === '[' || c === '{') v = this.parseFlow();
    else if (c === '*') v = this.parseAlias();
    else if (c === '"') v = this.parseDouble();
    else if (c === "'") v = this.parseSingle();
    else v = this.parsePlainFlow(at);
    return this.finishProps(props, v);
  }

  /** @param {number} at start of the flow collection (for errors) */
  skipFlowWs(at) {
    const s = this.s;
    for (;;) {
      const c = s[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.pos++; continue; }
      if (c === '#' && (this.pos === 0 || isWsOrEnd(s[this.pos - 1]) || s[this.pos - 1] === '\r')) {
        const e = s.indexOf('\n', this.pos); this.pos = e === -1 ? s.length : e; continue;
      }
      if (c === undefined) throw this.fail('unterminated flow collection', at);
      if (this.atDocMarker()) throw this.fail('unterminated flow collection', at);
      return;
    }
  }

  /** Plain scalar inside [..] / {..}. @param {number} at */
  parsePlainFlow(at) {
    const s = this.s;
    let out = '';
    for (;;) {
      const d = s[this.pos];
      if (d === undefined) throw this.fail('unterminated flow collection', at);
      if (d === ',' || d === ']' || d === '}' || d === '[' || d === '{') break;
      if (d === ':' && (isWsOrEnd(s[this.pos + 1]) || FLOW_IND.has(s[this.pos + 1]))) break;
      if (d === '#' && isWsOrEnd(s[this.pos - 1])) break;
      if (d === ' ' || d === '\t' || d === '\n' || d === '\r') {
        // look past whitespace: fold, or stop before an indicator / comment
        let q = this.pos;
        while (s[q] === ' ' || s[q] === '\t' || s[q] === '\n' || s[q] === '\r') q++;
        const e = s[q];
        if (e === undefined || e === '#' || e === ',' || e === ']' || e === '}' || (e === ':' && (isWsOrEnd(s[q + 1]) || FLOW_IND.has(s[q + 1])))) { this.pos = q; break; }
        // spaces inside a line are kept; line breaks fold (one → space, n → n-1 newlines)
        let n = 0;
        for (let i = this.pos; i < q; i++) if (s[i] === '\n') n++;
        out += n === 0 ? s.slice(this.pos, q) : n === 1 ? ' ' : '\n'.repeat(n - 1);
        this.pos = q;
        continue;
      }
      out += d;
      this.pos++;
    }
    this.lastPlain = out;
    return resolvePlain(out);
  }
}

/**
 * Parse YAML text (the first document). Throws YamlError with a line number and no file content.
 * @param {string} text
 * @param {{ maxChars?: number }} [opt]
 * @returns {any}
 */
export function parseYaml(text, opt = {}) {
  if (typeof text !== 'string') throw new TypeError('parseYaml needs a string');
  if (text.length > Math.min(opt.maxChars ?? MAX_YAML_CHARS, MAX_YAML_CHARS)) throw new YamlError('input is too large', 1);
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (s.includes('\r')) s = s.replace(/\r\n?/g, '\n');
  return new Parser(s).parseStream();
}

/**
 * Parse an OpenAPI / Swagger document given as JSON or YAML (whatever the file extension).
 * JSON is tried first; YAML only if that fails. Error messages never contain file content.
 * @param {string} text
 */
export function parseSpecText(text) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try { return JSON.parse(t); } catch { /* not JSON: try YAML */ }
  try {
    return parseYaml(t);
  } catch (e) {
    if (e instanceof YamlError) {
      // Never JSON.parse's message (Node quotes the input in it); the YAML reason is a fixed phrase plus a line.
      throw new Error(`spec is not valid JSON or YAML: ${e.message.replace(/^YAML: /, '')}`);
    }
    throw e;
  }
}
