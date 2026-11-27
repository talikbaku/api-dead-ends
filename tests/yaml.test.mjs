import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml, parseSpecText, resolvePlain, MAX_DEPTH } from '../src/yaml.mjs';
import { loadSpec, literalSegments } from '../src/spec.mjs';
import { parseUsage } from '../src/usage.mjs';
import { classify } from '../src/classify.mjs';
import { isIdSegment } from '../src/template.mjs';

const BIN = new URL('../bin/api-dead-ends.mjs', import.meta.url).pathname;
const EX = new URL('../examples/', import.meta.url).pathname;
const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
const y = (/** @type {TemplateStringsArray} */ s) => parseYaml(s.raw[0]);

/** Tiny YAML emitter for the round-trip twin (block style, double-quoted strings when needed). @param {any} v @param {string} ind */
function emit(v, ind = '') {
  const scalar = (/** @type {any} */ x) => (typeof x === 'string'
    ? (/^[A-Za-z][\w .\/-]*$/.test(x) && resolvePlain(x) === x && !/ $/.test(x) ? x : JSON.stringify(x))
    : JSON.stringify(x));
  const key = (/** @type {string} */ k) => (/^[\w\/{}.$-]+$/.test(k) ? k : JSON.stringify(k));
  const isColl = (/** @type {any} */ x) => x !== null && typeof x === 'object' && Object.keys(x).length > 0;
  if (Array.isArray(v)) {
    return v.map((x) => (isColl(x) ? `${ind}-\n${emit(x, ind + '  ')}` : `${ind}- ${Array.isArray(x) ? '[]' : x && typeof x === 'object' ? '{}' : scalar(x)}`)).join('\n');
  }
  return Object.entries(v).map(([k, x]) => (isColl(x)
    ? `${ind}${key(k)}:\n${emit(x, Array.isArray(x) ? ind : ind + '  ')}`
    : `${ind}${key(k)}: ${Array.isArray(x) ? '[]' : x && typeof x === 'object' ? '{}' : scalar(x)}`)).join('\n');
}

test('yaml: core schema scalars; keys stay strings', () => {
  assert.deepEqual(y`
a: 1
b: -2.5e3
c: 0x1F
d: 0o17
e: true
f: False
g: ~
h:
i: null
j: .inf
k: yes
l: 1.0.3
m: '200'
200: plain key
true: bool key
1e3: float key
n: 007
`, { a: 1, b: -2500, c: 31, d: 15, e: true, f: false, g: null, h: null, i: null, j: Infinity, k: 'yes', l: '1.0.3', m: '200', 200: 'plain key', true: 'bool key', '1e3': 'float key', n: 7 });
  assert.ok(Number.isNaN(parseYaml('x: .nan').x));
  assert.equal(parseYaml('x: !!str 200').x, '200');
  assert.equal(parseYaml('x: !!str').x, '');
  assert.equal(parseYaml('x: !!int 5').x, 5);
});

test('yaml: block mappings and sequences, incl. `- key: v` items and sequences at the key indent', () => {
  assert.deepEqual(y`
required:
- id
- name
tags:
  - a
  -   b
items:
  - name: x
    in: path
  - name: y
    schema:
      type: string
  -
    nested: true
  - - deep
    - er
empty:
last: end
`, { required: ['id', 'name'], tags: ['a', 'b'], items: [{ name: 'x', in: 'path' }, { name: 'y', schema: { type: 'string' } }, { nested: true }, ['deep', 'er']], empty: null, last: 'end' });
  assert.deepEqual(parseYaml('- a\n- b: 1\n  c: 2\n'), ['a', { b: 1, c: 2 }]);
  assert.deepEqual(parseYaml('  a: 1\n  b:\n    - x\n'), { a: 1, b: ['x'] }, 'whole document indented');
  assert.deepEqual(parseYaml('- name:\n    x: 1\n  other: 2\n- []\n-\n- last'), [{ name: { x: 1 }, other: 2 }, [], null, 'last']);
  assert.deepEqual(parseYaml('key   : v\nb: -foo\nc: -1\na: # c\n  b: 1\n  # comment\n\n  c: 2'), { key: 'v', b: '-foo', c: -1, a: { b: 1, c: 2 } });
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('# only a comment\n'), null);
  assert.equal(parseYaml('just text'), 'just text');
});

test('yaml: plain scalars with colons and hashes, comments, multi-line plain', () => {
  assert.deepEqual(y`
url: http://api.example.com:8080/v1 # trailing comment
path: /a:b
ref: '#/components/schemas/User'
hash: a#b
time: 12:30
desc: first line
  second line

  new paragraph
# comment line
next: 1
`, { url: 'http://api.example.com:8080/v1', path: '/a:b', ref: '#/components/schemas/User', hash: 'a#b', time: '12:30', desc: 'first line second line\nnew paragraph', next: 1 });
});

test('yaml: single and double quoted scalars, escapes, multi-line folding', () => {
  assert.deepEqual(y`
s: 'it''s # not a comment'
d: "tab\there \"q\" \\ \u00e9 \x41 \U0001F600 \/ \N"
e: ""
m: "one
  two

  three"
j: "joined\
  here"
k: 'a
   b'
"quoted key": 1
'single: key': 2
`, { s: "it's # not a comment", d: 'tab\there "q" \\ é A 😀 / \x85', e: '', m: 'one two\nthree', j: 'joinedhere', k: 'a b', 'quoted key': 1, 'single: key': 2 });
});

test('yaml: block scalars | and > with chomping and indentation indicators', () => {
  const r = y`
lit: |
  line 1
    indented

  line 3


strip: |-
  text

keep: |+
  text

folded: >
  a
  b

  c
    more
  d
fstrip: >-
  x
  y
ind: |2
    two extra
  base
hash: |
  # not a comment
  key: not a mapping
  ---
after: ok
`;
  assert.deepEqual(r, {
    lit: 'line 1\n  indented\n\nline 3\n', strip: 'text', keep: 'text\n\n', folded: 'a b\nc\n  more\nd\n', fstrip: 'x y',
    ind: '  two extra\nbase\n', hash: '# not a comment\nkey: not a mapping\n---\n', after: 'ok',
  });
  assert.deepEqual(parseYaml('- |\n  in a list\n- >-\n  folded\n  item\n'), ['in a list\n', 'folded item']);
  assert.equal(parseYaml('x: |\n').x, '');
});

test('yaml: flow collections, also across lines', () => {
  assert.deepEqual(y`
a: [x, y, 'z, w', "q"]
b: {k: 1, "j": [1, 2], e: {}}
c: []
d: {}
e: [
  one,   # comment
  two,
  {name: id, in: path},
]
f: {"json":"style","n":1}
g: [a: 1, b]
h: [multi word plain, http://x.y/z]
`, { a: ['x', 'y', 'z, w', 'q'], b: { k: 1, j: [1, 2], e: {} }, c: [], d: {}, e: ['one', 'two', { name: 'id', in: 'path' }], f: { json: 'style', n: 1 }, g: [{ a: 1 }, 'b'], h: ['multi word plain', 'http://x.y/z'] });
});

test('yaml: documents, directives, BOM, CRLF', () => {
  assert.deepEqual(parseYaml('%YAML 1.2\n---\na: 1\n...\n---\nb: 2\n'), { a: 1 });
  assert.deepEqual(parseYaml('---\na: 1\n---\nb: 2\n'), { a: 1 });
  assert.deepEqual(parseYaml('\ufeffa: 1\r\nb:\r\n  - x\r\nc: |\r\n  t\r\n'), { a: 1, b: ['x'], c: 't\n' });
  assert.deepEqual(parseYaml('--- {a: 1}\n'), { a: 1 });
});

test('yaml: anchors, aliases and merge keys', () => {
  const r = y`
base: &base
  type: string
  format: uuid
other: *base
merged:
  <<: *base
  format: email
multi:
  <<: [*base, {extra: 1}]
list: &l [1, 2]
again: *l
"<<": literal key
`;
  assert.deepEqual(r.other, { type: 'string', format: 'uuid' });
  assert.deepEqual(r.merged, { format: 'email', type: 'string' });
  assert.deepEqual(r.multi, { type: 'string', format: 'uuid', extra: 1 });
  assert.deepEqual(r.again, [1, 2]);
  assert.equal(r['<<'], 'literal key');
});

test('yaml: errors carry a line number and never the file content', () => {
  const cases = [
    ['a: 1\n\tb: SECRET1', /tabs.*line 2/],
    ['a: 1\na: SECRET2', /duplicate key.*line 2/],
    ['a: !custom SECRET3', /custom tags.*line 1/],
    ['? [SECRET4]\n: v', /complex keys.*line 1/],
    ['a: "SECRET5\nb: 1', /unterminated.*line 1/],
    ['a: [SECRET6, b\n', /unterminated flow.*line 1/],
    ['a: b: SECRET7', /same line.*line 1/],
    ['a:\n  b: 1\n c: SECRET8', /indentation.*line 3/],
    ['a: *SECRET9', /unknown alias.*line 1/],
    ['a: "bad \\q SECRET10"', /bad escape.*line 1/],
    ['a: x\n  y: SECRET11', /line 2/],
  ];
  for (const [src, re] of cases) {
    assert.throws(() => parseYaml(String(src)), (e) => {
      assert.match(e.message, /** @type {RegExp} */ (re), String(src));
      assert.doesNotMatch(e.message, /SECRET/);
      assert.equal(e.message.includes('\n'), false);
      return true;
    });
  }
});

test('yaml: __proto__ is refused; constructor/prototype are plain own keys; no prototype pollution', () => {
  for (const src of ['__proto__:\n  polluted: 1', 'a: {__proto__: {polluted: 1}}', '"__proto__": {polluted: 1}', 'a: [__proto__: {polluted: 1}]']) {
    assert.throws(() => parseYaml(src), /__proto__ is not allowed/, src);
  }
  const r = parseYaml('constructor:\n  prototype:\n    polluted: 1\nprototype: {polluted: 1}\ntoString: x\n');
  assert.ok(Object.hasOwn(r, 'constructor') && Object.hasOwn(r, 'prototype'));
  assert.deepEqual(r.constructor, { prototype: { polluted: 1 } });
  assert.equal(r.toString, 'x');
  assert.equal(Object.getPrototypeOf(r), Object.prototype);
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  assert.equal(/** @type {any} */ (Object.prototype).polluted, undefined);
  assert.equal(typeof ({}).toString, 'function');
  // merge from a mapping with dangerous-looking keys stays own-property only
  const m = parseYaml('a: &a {constructor: 1}\nb:\n  <<: *a\n');
  assert.equal(m.b.constructor, 1);
  assert.equal(/** @type {any} */ ({}).constructor, Object);
});

test('yaml: alias bombs, self-references and deep nesting are refused cleanly', () => {
  const bomb = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]'];
  for (let i = 1; i <= 8; i++) bomb.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(10).fill(`*${String.fromCharCode(96 + i)}`).join(',')}]`);
  const t0 = Date.now();
  assert.throws(() => parseYaml(bomb.join('\n')), /alias bomb/);
  assert.ok(Date.now() - t0 < 15000);
  // the same with a mapping at the bottom
  const mb = ['a0: &a0 {k0: 1, k1: 1, k2: 1, k3: 1, k4: 1, k5: 1, k6: 1, k7: 1, k8: 1, k9: 1}'];
  for (let i = 1; i <= 8; i++) mb.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
  assert.throws(() => parseYaml(mb.join('\n')), /alias bomb/);
  assert.throws(() => parseYaml('a: &a [*a]'), /unknown alias/);
  assert.throws(() => parseYaml('['.repeat(MAX_DEPTH + 5)), /nesting is too deep/);
  assert.throws(() => parseYaml('{a: '.repeat(10000)), /nesting is too deep/);
  let deep = '';
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep += `${' '.repeat(i)}k:\n`;
  assert.throws(() => parseYaml(deep), /nesting is too deep/);
  assert.throws(() => parseYaml('&a\n'.repeat(50000)), /nesting is too deep/);
  assert.throws(() => parseYaml('k: !!str\n'.repeat(50000)), /nesting is too deep|duplicate key/);
  assert.throws(() => parseYaml('!!str\n'.repeat(50000)), /nesting is too deep/);
  assert.throws(() => parseYaml('a: 1\n', { maxChars: 3 }), /input is too large/);
  // a long single line is parsed in linear time
  const long = `a: [${Array(200000).fill('x').join(', ')}]`;
  const t1 = Date.now();
  assert.equal(parseYaml(long).a.length, 200000);
  assert.ok(Date.now() - t1 < 15000);
});

test('yaml: explicit `? key` / `: value` entries with scalar keys (PyYAML long keys, Twilio spec)', () => {
  const long = `api.v2010.account.incoming_phone_number.incoming_phone_number_assigned_add_on.${'x'.repeat(80)}`;
  assert.deepEqual(parseYaml(`components:
  schemas:
    ? ${long}
    : type: object
      properties:
        sid: {type: string}
    plain:
      type: string
`), { components: { schemas: { [long]: { type: 'object', properties: { sid: { type: 'string' } } }, plain: { type: 'string' } } } });
  assert.deepEqual(y`
? "quoted key"
: - a
  - b
? 'single'   # comment
:
  nested: 1
? no value
? multi
  line key
: v
`, { 'quoted key': ['a', 'b'], single: { nested: 1 }, 'no value': null, 'multi line key': 'v' });
  assert.deepEqual(parseYaml('- ? a\n  : b\n- c\n'), [{ a: 'b' }, 'c']);
  assert.deepEqual(parseYaml('?x: 1\n? y\n: 2\n'), { '?x': 1, y: 2 }); // `?` without a space is a plain key
  assert.deepEqual(parseYaml('{? a, ? b : 1, c: 2}'), { a: null, b: 1, c: 2 });
  assert.deepEqual(parseYaml('[? a, ? b : c, d]'), [{ a: null }, { b: 'c' }, 'd']);
  // a collection as a key is still refused
  for (const src of ['? [a]\n: v', '? {a: 1}\n: v', '? - a\n: v', '? a: b\n: v', '?\n  a\n: v', '? &x a\n: v', '{? [a]: v}']) {
    assert.throws(() => parseYaml(src), /complex keys/, src);
  }
});

test('yaml: tabs after the indentation are content / separation, not indentation', () => {
  // block scalars: a tab after the indent is content, not an empty line
  assert.equal(parseYaml('a: |\n  x\n  \ty\n  \t\n').a, 'x\n\ty\n\t\n');
  assert.equal(parseYaml('a: |-\n  \t\n  x\n').a, '\t\nx');
  assert.equal(parseYaml('a: >\n  x\n  \ty\n  \t\n  z\n').a, 'x\n\ty\n\t\nz\n');
  assert.equal(parseYaml('a: >-\n  \t\n  x\n').a, '\t\nx');
  assert.equal(parseYaml('a: |\n  x\n  \n\n  y\n').a, 'x\n\n\ny\n');
  // plain scalar continuation line: spaces indent it, a tab may follow
  assert.deepEqual(parseYaml('a: x\n  \ty\nb: 1\n'), { a: 'x y', b: 1 });
  assert.throws(() => parseYaml('a: x\n\ty\n'), /tabs are not allowed for indentation \(line 2\)/);
});

test('yaml: flow plain scalars keep inner spaces and fold only line breaks', () => {
  assert.deepEqual(parseYaml('{a: x.  y}\n'), { a: 'x.  y' });
  assert.deepEqual(parseYaml('[a \t b, c]'), ['a \t b', 'c']);
  assert.deepEqual(parseYaml('{a: x  \n   y,\n b: x\n\n  y z  }'), { a: 'x y', b: 'x\ny z' });
});

test('yaml: core tags !!int !!float !!bool !!null are applied, !!str kept; bad values are refused', () => {
  assert.deepEqual(y`
deprecated: !!bool "false"
on: !!bool true
n: !!int "5"
h: !!int '0x1F'
f: !!float "1.5"
g: !!float 2
z: !!null ""
t: !!null ~
s: !!str 200
prev: foo
e: !!str
`, { deprecated: false, on: true, n: 5, h: 31, f: 1.5, g: 2, z: null, t: null, s: '200', prev: 'foo', e: '' });
  assert.deepEqual(parseYaml('[!!int "7", !!bool "true"]'), [7, true]);
  for (const src of ['a: !!bool "yes"', 'a: !!int 1.5', 'a: !!float abc', 'a: !!null x', 'a: !!int']) {
    assert.throws(() => parseYaml(src), /does not match its !!\w+ tag \(line 1\)/, src);
  }
});

test('yaml: many-line quoted scalars and deep comment runs parse in linear time', () => {
  for (const q of ["'", '"']) {
    const src = `a: ${q}${'xy  \n'.repeat(200000)}${q}\n`; // 1 MB, 200k lines
    const t0 = Date.now();
    const v = parseYaml(src).a;
    const ms = Date.now() - t0;
    assert.equal(v, "xy ".repeat(200000)); // every break folds to a space
    assert.ok(ms < 1000, `${q}-quoted 1 MB took ${ms} ms`);
  }
  // trailing spaces before a fold are dropped, escaped ones kept
  assert.equal(parseYaml('a: "x \\t \n  y"').a, 'x \t y');
  assert.equal(parseYaml("a: 'x ''  \n\n  y'").a, "x '\ny");
  // blank/comment lines after deep nesting are skipped once, not once per closing level
  let src = '';
  for (let i = 0; i < 250; i++) src += `${' '.repeat(i)}k:\n`;
  src += '#\n'.repeat(400000) + 'z: 1\n';
  const t0 = Date.now();
  assert.equal(parseYaml(src).z, 1);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `deep comment run took ${ms} ms`);
});

test('parseSpecText: JSON first, YAML otherwise; both failing → the YAML reason with its line, never file content', () => {
  assert.deepEqual(parseSpecText('{"a": 1}'), { a: 1 });
  assert.deepEqual(parseSpecText('a: 1'), { a: 1 });
  assert.deepEqual(parseSpecText('{a: 1}'), { a: 1 });
  assert.throws(() => parseSpecText('{"paths": {"/x": '), /^Error: spec is not valid JSON or YAML: unterminated flow collection \(line 1\)$/);
  assert.throws(() => parseSpecText('a: 1\na: 2'), /not valid JSON or YAML: duplicate key \(line 2\)/);
  // flow-style YAML (starts with { or [): the YAML reason and line, not just "not valid JSON"
  const flow = '{openapi: 3.0.0, info: {title: t, version: "1"},\n paths: {/a: {get: {}}, /a: {get: {}}}}\n';
  assert.throws(() => parseSpecText(flow), /^Error: spec is not valid JSON or YAML: duplicate key \(line 2\)$/);
  assert.throws(() => parseSpecText('{a: 1, a: 2}\n'), /duplicate key \(line 1\)/);
  assert.throws(() => parseSpecText('{__proto__: 1}'), /__proto__ is not allowed \(line 1\)/);
  assert.throws(() => parseSpecText('[a]: 1'), /\(line 1\)/);
  // never file content (JSON.parse messages quote the input)
  try { parseSpecText('{"secretKey": tokenVALUE123'); assert.fail('no error'); } catch (e) { assert.doesNotMatch(e.message, /secretKey|tokenVALUE123/); }
});

test('YAML tags on collections: scalar tags, !!map on a sequence and !!seq on a mapping are refused', () => {
  assert.throws(() => parseYaml('a: !!str [1]\n'), /a !!str tag cannot be on a sequence \(line 1\)/);
  assert.throws(() => parseYaml('a: !!int {b: 1}\n'), /a !!int tag cannot be on a mapping \(line 1\)/);
  assert.throws(() => parseYaml('a: !!map [1]\n'), /does not match its !!map tag \(line 1\)/);
  assert.throws(() => parseYaml('a: !!seq {b: 1}\n'), /does not match its !!seq tag \(line 1\)/);
  assert.throws(() => parseYaml('a: !!seq 1\n'), /does not match its !!seq tag/);
  assert.throws(() => parseYaml('a: !!map x\n'), /does not match its !!map tag/);
  // block collections, the reported line is the tag's (inner tags do not move it)
  assert.throws(() => parseYaml('x: 1\ny: !!str\n  b: [!!int 2]\n'), /a !!str tag cannot be on a mapping \(line 2\)/);
  assert.throws(() => parseYaml('x: 1\ny:\n  - !!bool\n    - 1\n'), /a !!bool tag cannot be on a sequence \(line 3\)/);
  // matching tags and empty values are fine
  assert.deepEqual(parseYaml('a: !!seq\n  - 1\nb: !!map\n  c: 1\nd: !!seq [2]\ne: !!map {f: 3}\ng: !!map\n'), { a: [1], b: { c: 1 }, d: [2], e: { f: 3 }, g: null });
  assert.deepEqual(parseYaml('a: !!str 1\n'), { a: '1' });
});

test('spec: deprecated only when it is exactly true (a quoted "false" is not deprecated)', () => {
  const ops = loadSpec(parseYaml('openapi: 3.0.0\npaths:\n  /a:\n    get:\n      deprecated: "false"\n  /b:\n    get:\n      deprecated: true\n  /c:\n    get:\n      deprecated: 1\n')).ops;
  assert.deepEqual(ops.map((o) => [o.path, o.deprecated]), [['/a', false], ['/b', true], ['/c', false]]);
});

const OPENAPI_YAML = `# Hand-written OpenAPI 3 file in the styles real tools emit.
openapi: 3.0.3
info:
  title: Pets API
  version: '2.1'
  description: |
    Multi-line description with: colons, # hashes
    and **markdown**.
servers:
  - url: https://pets.example.com/api/v2
    description: prod
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      parameters:
      - name: limit
        in: query
        required: false
        schema: {type: integer, maximum: 100}
      responses:
        200:
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Pet'
        default: &err
          description: >-
            Unexpected
            error
    post:
      operationId: createPet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Pet" }
      responses:
        '201': {description: created}
        default: *err
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - {name: petId, in: path, required: true, schema: {type: string}}
      responses:
        "200": {description: ok}
    delete:
      deprecated: true
      responses:
        '204':
          description: gone
components:
  schemas:
    Pet:
      type: object
      required:
      - id
      - name
      properties:
        id: {type: string, format: uuid}
        name:
          type: string
          example: "Rex"
        tag:
          type: string
          nullable: true
          enum: [dog, cat, null]
`;

const OPENAPI_JSON = {
  openapi: '3.0.3',
  info: { title: 'Pets API', version: '2.1', description: 'Multi-line description with: colons, # hashes\nand **markdown**.\n' },
  servers: [{ url: 'https://pets.example.com/api/v2', description: 'prod' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets', tags: ['pets'],
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 100 } }],
        responses: {
          200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } },
          default: { description: 'Unexpected error' },
        },
      },
      post: {
        operationId: 'createPet',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { 201: { description: 'created' }, default: { description: 'Unexpected error' } },
      },
    },
    '/pets/{petId}': {
      get: { operationId: 'getPet', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } },
      delete: { deprecated: true, responses: { 204: { description: 'gone' } } },
    },
  },
  components: { schemas: { Pet: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string', example: 'Rex' }, tag: { type: 'string', nullable: true, enum: ['dog', 'cat', null] } } } } },
};

test('openapi 3 YAML fixture equals its JSON twin and loads the same operations', () => {
  const doc = parseYaml(OPENAPI_YAML);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(doc)), JSON.parse(JSON.stringify(OPENAPI_JSON)));
  const a = loadSpec(doc), b = loadSpec(OPENAPI_JSON);
  assert.deepEqual(a.ops.map((o) => `${o.method} ${o.path} ${o.deprecated}`), b.ops.map((o) => `${o.method} ${o.path} ${o.deprecated}`));
  assert.equal(a.base, '/api/v2');
  assert.equal(a.ops.length, 4);
});

test('swagger 2 YAML loads with basePath', () => {
  const spec = loadSpec(parseSpecText(`swagger: "2.0"
info: {title: Legacy, version: 1.0.0}
basePath: /legacy/
schemes: [https]
paths:
  /users/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          type: string
      responses:
        200:
          description: OK
          schema:
            $ref: '#/definitions/User'
    put:
      deprecated: true
      responses: {200: {description: OK}}
definitions:
  User:
    type: object
    properties:
      id: {type: string}
`));
  assert.equal(spec.base, '/legacy');
  assert.equal(spec.version, '1.0.0');
  assert.deepEqual(spec.ops.map((o) => `${o.method} ${o.path}`), ['GET /users/{id}', 'PUT /users/{id}']);
  assert.ok(spec.ops[0].re.test('/legacy/users/42'));
  // unquoted numbers in info read as numbers (YAML core schema) but reach the report as strings
  const n = loadSpec(parseSpecText('swagger: 2.0\ninfo: {title: 2024, version: 1.5}\npaths: {/a: {get: {}}}\n'));
  assert.equal(n.title, '2024');
  assert.equal(n.version, '1.5');
  assert.equal(spec.ops[1].deprecated, true);
});

test('examples/shop.openapi.json as YAML gives the same document and the same classification', () => {
  const json = JSON.parse(readFileSync(join(EX, 'shop.openapi.json'), 'utf8'));
  const yamlText = emit(json) + '\n';
  assert.deepStrictEqual(parseYaml(yamlText), json);
  const usage = readFileSync(join(EX, 'shop-usage.csv'), 'utf8');
  const result = (/** @type {any} */ doc) => {
    const spec = loadSpec(doc);
    const r = classify(parseUsage(usage, { keep: literalSegments(spec, isIdSegment) }), spec, { days: 30 });
    return { totals: r.totals, endpoints: r.endpoints.map((e) => `${e.method} ${e.path} ${e.class} ${e.calls}`), shadow: r.shadow.map((e) => `${e.method} ${e.path}`) };
  };
  assert.deepEqual(result(parseSpecText(yamlText)), result(json));
});

test('cli: report --spec x.yaml matches the JSON spec; YAML in a file of any name; bad YAML exits 2 without content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-yaml-'));
  const json = readFileSync(join(EX, 'shop.openapi.json'), 'utf8');
  const yamlText = emit(JSON.parse(json)) + '\n';
  writeFileSync(join(dir, 'shop.openapi.yaml'), yamlText);
  writeFileSync(join(dir, 'spec.txt'), yamlText);
  const usage = join(EX, 'shop-usage.csv');
  const strip = (/** @type {string} */ f) => { const j = JSON.parse(readFileSync(f, 'utf8')); delete j.generated; delete j.generatedAt; delete j.tool; return j; };
  const outs = [];
  for (const [i, spec] of [join(EX, 'shop.openapi.json'), join(dir, 'shop.openapi.yaml'), join(dir, 'spec.txt')].entries()) {
    const r = run('report', '--usage', usage, '--spec', spec, '--out', join(dir, `r${i}`));
    assert.equal(r.status, 0, r.stderr);
    outs.push(strip(join(dir, `r${i}`, 'report.json')));
  }
  assert.deepEqual(outs[1], outs[0]);
  assert.deepEqual(outs[2], outs[0]);

  writeFileSync(join(dir, 'bad.yaml'), 'openapi: 3.0.0\npaths:\n  /x: TOPSECRET: 1\n');
  const bad = run('report', '--usage', usage, '--spec', join(dir, 'bad.yaml'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /YAML.*line 3/);
  assert.doesNotMatch(bad.stderr, /TOPSECRET/);

  const conv = run('convert', 'csv', usage, '--spec', join(dir, 'shop.openapi.yaml'), '-o', join(dir, 'u.csv'));
  assert.equal(conv.status, 0, conv.stderr);
});

/** @param {string} cwd @param {any[]} calls */
async function mcp(cwd, calls) {
  const p = spawn(process.execPath, [BIN, 'mcp'], { cwd });
  let buf = '';
  /** @type {any[]} */
  const out = [];
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const msgs = [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    ...calls.map(([name, args], i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } }))];
  p.stdin.end(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  await new Promise((r) => p.on('close', r));
  return Object.fromEntries(out.map((m) => [m.id, m.result]));
}

test('mcp: analyze_usage reads a YAML spec; YAML errors leak no file content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-yaml-mcp-'));
  const json = readFileSync(join(EX, 'shop.openapi.json'), 'utf8');
  writeFileSync(join(dir, 'openapi.json'), json);
  writeFileSync(join(dir, 'openapi.yml'), emit(JSON.parse(json)) + '\n');
  writeFileSync(join(dir, 'usage.csv'), readFileSync(join(EX, 'shop-usage.csv'), 'utf8'));
  writeFileSync(join(dir, 'bad.yml'), 'paths:\n  /x:\n    get: {a: 1\n# MARKER_SECRET_xyz\n');
  writeFileSync(join(dir, 'bomb.yml'), ['a: &a [x,x,x,x,x,x,x,x,x,x]', ...Array.from({ length: 8 }, (_, i) => `${'bcdefghi'[i]}: &${'bcdefghi'[i]} [${Array(10).fill(`*${'abcdefgh'[i]}`).join(',')}]`)].join('\n'));
  writeFileSync(join(dir, 'proto.yml'), '__proto__:\n  MARKER_SECRET_xyz: 1\npaths: {}\n');
  const r = await mcp(dir, [
    ['analyze_usage', { usage: 'usage.csv', spec: 'openapi.json' }],
    ['analyze_usage', { usage: 'usage.csv', spec: 'openapi.yml' }],
    ['analyze_usage', { usage: 'usage.csv', spec: 'bad.yml' }],
    ['analyze_usage', { usage: 'usage.csv', spec: 'bomb.yml' }],
    ['analyze_usage', { usage: 'usage.csv', spec: 'proto.yml' }],
  ]);
  assert.equal(r[1].isError, false);
  assert.equal(r[2].isError, false);
  assert.deepEqual(JSON.parse(r[2].content[0].text), JSON.parse(r[1].content[0].text));
  for (const id of [3, 4, 5]) assert.equal(r[id].isError, true, `call ${id} must fail`);
  assert.match(r[3].content[0].text, /line \d+/);
  assert.match(r[4].content[0].text, /alias bomb/);
  assert.match(r[5].content[0].text, /__proto__ is not allowed/);
  assert.doesNotMatch(JSON.stringify(r), /MARKER_SECRET/);
  assert.equal(/** @type {any} */ (Object.prototype).MARKER_SECRET_xyz, undefined);
});
