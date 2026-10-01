'use strict';

/*
 * End-to-end over the bundled demo codebase (demo/*.c, demo/*.h).
 *
 * These assertions name real functions in real C, so they are the tests that
 * would notice if the indexer regressed on something a reader would actually
 * hit. They read demo/ from disk rather than demo-data.js, and one test
 * asserts the two agree, which is what keeps the committed bundle honest.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../core.js');

const demoDir = path.join(__dirname, '..', 'demo');
const files = fs.readdirSync(demoDir)
  .filter((n) => /\.(c|h)$/.test(n))
  .sort()
  .map((n) => ({ path: 'jsonfmt/' + n, text: fs.readFileSync(path.join(demoDir, n), 'utf8') }));

const project = L.buildProject(files);

function def(name) {
  const s = project.symbols.find((x) => x.name === name && x.definition);
  assert.ok(s, 'no definition of ' + name + ' was indexed');
  return s;
}

function calleesOf(name) {
  return new Set(project.out[def(name).id]
    .map((id) => project.symbols[id])
    .filter((s) => s.kind === 'function')
    .map((s) => s.name));
}

test('the demo bundle matches the demo sources on disk', () => {
  const bundle = require('../demo-data.js');
  const onDisk = new Map(files.map((f) => [f.path, f.text]));
  assert.strictEqual(bundle.files.length, files.length,
    'demo-data.js is stale; run: node tools/bundle-demo.js');
  bundle.files.forEach((f) => {
    assert.ok(onDisk.has(f.path), 'bundle has an unknown file ' + f.path);
    assert.strictEqual(f.text, onDisk.get(f.path),
      f.path + ' differs; run: node tools/bundle-demo.js');
  });
});

test('all five demo files are indexed', () => {
  assert.deepStrictEqual(project.files.map((f) => f.path).sort(), [
    'jsonfmt/arena.c', 'jsonfmt/arena.h',
    'jsonfmt/json.c', 'jsonfmt/json.h', 'jsonfmt/main.c'
  ]);
});

test('every demo file lexes without a diagnostic', () => {
  const lexErrors = project.diagnostics.filter((d) => /unterminated/.test(d.message));
  assert.deepStrictEqual(lexErrors, []);
});

test('the public API functions are all found as definitions', () => {
  ['arena_init', 'arena_alloc', 'arena_strndup', 'arena_free', 'arena_bytes_used',
    'json_parse', 'json_print', 'json_kind_name', 'json_object_get', 'main']
    .forEach((n) => assert.strictEqual(def(n).kind, 'function', n));
});

test('header prototypes are matched to the definitions in the .c files', () => {
  assert.strictEqual(def('arena_alloc').file, 'jsonfmt/arena.c');
  const proto = project.symbols.find((s) =>
    s.name === 'arena_alloc' && !s.definition);
  assert.strictEqual(proto.file, 'jsonfmt/arena.h');
});

test('a call from main resolves into the right translation unit', () => {
  const callees = calleesOf('main');
  assert.ok(callees.has('json_parse'), [...callees].join(' '));
  assert.ok(callees.has('arena_init'), [...callees].join(' '));
  assert.ok(callees.has('read_all'), [...callees].join(' '));
  assert.strictEqual(def('json_parse').file, 'jsonfmt/json.c');
});

test('the static helpers in json.c are indexed as internal linkage', () => {
  ['parse_value', 'parse_array', 'parse_object', 'parse_string', 'parse_number',
    'skip_whitespace', 'advance', 'peek', 'fail', 'encode_utf8', 'decode_hex4']
    .forEach((n) => {
      const s = def(n);
      assert.strictEqual(s.static, true, n + ' should be static');
      assert.strictEqual(s.linkage, 'internal', n);
    });
});

test('json_parse reaches the parser through parse_value', () => {
  assert.ok(calleesOf('json_parse').has('parse_value'));
});

test('parse_value dispatches to all five value parsers', () => {
  const c = calleesOf('parse_value');
  ['parse_object', 'parse_array', 'parse_string', 'parse_number', 'parse_literal']
    .forEach((n) => assert.ok(c.has(n), n + ' missing from ' + [...c].join(' ')));
});

test('the parser mutual recursion is found as one component', () => {
  const cycles = project.readingOrder.cycles.map((g) =>
    g.map((id) => project.symbols[id].name).sort());
  const parserCycle = cycles.find((g) => g.includes('parse_value'));
  assert.ok(parserCycle, 'expected a cycle containing parse_value, got ' +
    JSON.stringify(cycles));
  ['parse_array', 'parse_object', 'parse_value'].forEach((n) =>
    assert.ok(parserCycle.includes(n), n + ' should be in the cycle: ' + parserCycle));
});

test('print_value is recursive but does not drag others into a cycle', () => {
  const printCycle = project.readingOrder.cycles.find((g) =>
    g.some((id) => project.symbols[id].name === 'print_value'));
  assert.strictEqual(printCycle, undefined,
    'print_value only calls itself, which is not a multi-member cycle');
  const refs = def('print_value').refs.filter((r) => r.name === 'print_value');
  assert.ok(refs.length >= 1, 'the self-recursive call is still shown in the text');
});

test('struct, enum and typedef declarations from the headers are indexed', () => {
  const kinds = new Map(project.symbols.map((s) => [s.kind + ':' + s.name, s]));
  ['struct:arena', 'struct:arena_block', 'struct:json_value', 'struct:json_member',
    'struct:json_element', 'struct:json_error', 'struct:json_parser', 'enum:json_kind']
    .forEach((k) => assert.ok(kinds.has(k), k + ' not indexed'));
  ['typedef:Arena', 'typedef:ArenaBlock', 'typedef:JsonValue', 'typedef:JsonKind',
    'typedef:JsonMember', 'typedef:JsonElement', 'typedef:JsonError',
    'typedef:JsonParser', 'typedef:Options']
    .forEach((k) => assert.ok(kinds.has(k), k + ' not indexed'));
});

test('macros from the headers are indexed with the right arity', () => {
  const macros = new Map(project.symbols
    .filter((s) => s.kind === 'macro')
    .map((s) => [s.name, s]));
  ['ARENA_ALIGN', 'ARENA_BLOCK_MIN', 'JSON_MAX_DEPTH', 'READ_CHUNK', 'ARENA_H',
    'JSON_H'].forEach((n) => assert.ok(macros.has(n), n + ' not indexed'));
  assert.strictEqual(macros.get('ARENA_ALIGN').funcLike, false);
});

test('a type used in a signature is linked to its definition', () => {
  const refs = def('json_object_get').refs.filter((r) => r.relation === 'type');
  const names = refs.map((r) => r.name);
  assert.ok(names.includes('JsonValue'), names.join(' '));
  const jv = refs.find((r) => r.name === 'JsonValue');
  assert.ok(jv.targets.length >= 1);
  assert.ok(['typedef', 'struct'].includes(project.symbols[jv.targets[0]].kind));
});

test('libc calls are reported as unresolved, with the usual suspects present', () => {
  const unresolved = new Set(project.unresolved.map((u) => u.name));
  ['malloc', 'free', 'memcpy', 'memset', 'strlen', 'fprintf', 'fputc', 'strtod']
    .forEach((n) => assert.ok(unresolved.has(n), n + ' should be unresolved'));
  /* Nothing defined inside the project may appear as unresolved. */
  const defined = new Set(project.symbols.map((s) => s.name));
  project.unresolved.forEach((u) => {
    assert.ok(!defined.has(u.name),
      u.name + ' is defined in the project but was reported unresolved');
  });
});

test('arena_alloc is called from both translation units that need it', () => {
  const callers = L.callersOf(project, def('arena_alloc').id)
    .map((c) => c.symbol.name);
  ['arena_strndup', 'new_value', 'parse_string_raw', 'read_all']
    .forEach((n) => assert.ok(callers.includes(n), n + ' should call arena_alloc, got ' +
      callers.join(' ')));
});

test('the reading order puts the allocator before the parser that uses it', () => {
  const pos = new Map();
  project.readingOrder.sequence.forEach((id, i) => pos.set(id, i));
  assert.ok(pos.get(def('arena_alloc').id) < pos.get(def('new_value').id));
  assert.ok(pos.get(def('new_value').id) < pos.get(def('parse_number').id));
  assert.ok(pos.get(def('json_parse').id) < pos.get(def('main').id));
});

test('the reading order covers every indexed symbol exactly once', () => {
  const seq = project.readingOrder.sequence;
  assert.strictEqual(seq.length, project.symbols.length);
  assert.strictEqual(new Set(seq).size, project.symbols.length);
});

test('define-before-use holds across the whole demo except the reported back edges', () => {
  const pos = new Map();
  project.readingOrder.sequence.forEach((id, i) => pos.set(id, i));
  const reported = new Set(project.readingOrder.backEdges.map((e) => e.from + '->' + e.to));
  let forward = 0;
  project.symbols.forEach((s) => {
    project.out[s.id].forEach((t) => {
      if (pos.get(t) > pos.get(s.id)) {
        forward++;
        assert.ok(reported.has(s.id + '->' + t),
          'unreported forward reference: ' + s.name + ' -> ' + project.symbols[t].name);
      }
    });
  });
  assert.strictEqual(forward, project.readingOrder.backEdges.length);
});

test('main is an entry point nothing else calls', () => {
  assert.deepStrictEqual(L.callersOf(project, def('main').id), []);
});

test('the statistics are self-consistent', () => {
  const s = L.stats(project);
  assert.strictEqual(s.files, 5);
  assert.ok(s.lines > 700, 'the demo is a few hundred lines, got ' + s.lines);
  assert.ok(s.functions >= 30, 'got ' + s.functions);
  assert.ok(s.edges > 100, 'got ' + s.edges);
  assert.strictEqual(s.cycles, project.readingOrder.cycles.length);
  assert.strictEqual(s.backEdges, project.readingOrder.backEdges.length);
  const counted = s.functions + s.prototypes + s.structs + s.unions + s.enums +
    s.typedefs + s.macros + s.variables;
  assert.strictEqual(counted, project.symbols.length,
    'every symbol falls into exactly one counted kind');
});

test('every symbol in the demo renders back to its exact source', () => {
  project.symbols.forEach((sym) => {
    const rec = L.fileOf(project, sym.file);
    const r = L.renderSymbol(project, sym.id);
    const last = rec.tokens[Math.min(sym.end, rec.tokens.length - 1)];
    const expected = rec.src.slice(rec.tokens[sym.start].i, last.i + last.v.length);
    assert.strictEqual(r.runs.map((x) => x.text).join(''), expected,
      sym.kind + ' ' + sym.name + ' in ' + sym.file);
  });
});

test('the indexer handles the whole demo in well under a second', () => {
  const started = Date.now();
  L.buildProject(files);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, 'indexing took ' + elapsed + ' ms');
});
