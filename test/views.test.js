'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../core.js');

/* ------------------------------------------------------------------ *
 * renderSymbol: the reading surface must reproduce the source exactly
 * ------------------------------------------------------------------ */

test('the runs of a symbol concatenate back to its exact source text', () => {
  const src =
    '/* doc */\n' +
    'int add(int a, int b)\n' +
    '{\n' +
    '    /* sum them */\n' +
    '    return a + b;  // done\n' +
    '}\n';
  const p = L.buildProject([{ path: 'a.c', text: src }]);
  const sym = p.symbols.find((s) => s.name === 'add');
  const r = L.renderSymbol(p, sym.id);
  const rebuilt = r.runs.map((x) => x.text).join('');
  const expected = src.slice(
    p.files[0].tokens[sym.start].i,
    p.files[0].tokens[sym.end].i + p.files[0].tokens[sym.end].v.length);
  assert.strictEqual(rebuilt, expected);
});

test('the reading surface reproduces every symbol of a multi-file project', () => {
  const files = [
    { path: 'a.c', text:
      '#define N 3\n' +
      'typedef struct point { int x, y; } Point;\n' +
      'static int sum(Point *p) { return p->x + p->y; }\n' +
      'int go(void) { Point p = { N, N }; return sum(&p); }\n' },
    { path: 'b.c', text:
      'static const char *msg = "hi \\" there";\n' +
      'const char *greet(void) { return msg; }\n' }
  ];
  const p = L.buildProject(files);
  assert.ok(p.symbols.length > 5);
  p.symbols.forEach((sym) => {
    const rec = L.fileOf(p, sym.file);
    const r = L.renderSymbol(p, sym.id);
    const expected = rec.src.slice(
      rec.tokens[sym.start].i,
      rec.tokens[sym.end].i + rec.tokens[sym.end].v.length);
    assert.strictEqual(r.runs.map((x) => x.text).join(''), expected, sym.name);
  });
});

test('reference anchors sit on the name token and carry their targets', () => {
  const p = L.buildProject([{ path: 'a.c', text:
    'int helper(void) { return 1; }\n' +
    'int caller(void) { return helper(); }\n' }]);
  const caller = p.symbols.find((s) => s.name === 'caller');
  const r = L.renderSymbol(p, caller.id);
  const anchored = r.runs.filter((x) => x.ref);
  assert.strictEqual(anchored.length, 1);
  assert.strictEqual(anchored[0].text, 'helper');
  assert.strictEqual(anchored[0].ref.relation, 'call');
  assert.strictEqual(p.symbols[anchored[0].ref.targets[0]].name, 'helper');
});

test('the first line number reported matches the symbol position', () => {
  const p = L.buildProject([{ path: 'a.c', text:
    '\n\nint f(void)\n{\n    return 0;\n}\n' }]);
  const sym = p.symbols.find((s) => s.name === 'f');
  const r = L.renderSymbol(p, sym.id);
  assert.strictEqual(r.firstLine, 3);
});

test('token classes mark keywords, strings, types and macros for highlighting', () => {
  const p = L.buildProject([{ path: 'a.c', text:
    '#define CAP 8\n' +
    'typedef struct w { int a; } W;\n' +
    'static const char *f(W *w) { return w->a > CAP ? "big" : "small"; }\n' }]);
  const sym = p.symbols.find((s) => s.name === 'f' && s.definition);
  const r = L.renderSymbol(p, sym.id);
  const byClass = {};
  r.runs.forEach((x) => { byClass[x.kind] = (byClass[x.kind] || 0) + 1; });
  assert.ok(byClass.keyword > 0, 'keywords found');
  assert.ok(byClass.string >= 2, 'both string literals classed');
  assert.ok(r.runs.some((x) => x.kind === 'type' && x.text === 'W'), 'W is a type');
  assert.ok(r.runs.some((x) => x.kind === 'macro' && x.text === 'CAP'), 'CAP is a macro');
});

test('renderSymbol returns null for an unknown id rather than throwing', () => {
  const p = L.buildProject([{ path: 'a.c', text: 'int x;\n' }]);
  assert.strictEqual(L.renderSymbol(p, 9999), null);
});

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

test('fuzzyScore matches subsequences and rejects non-matches', () => {
  assert.ok(L.fuzzyScore('pv', 'parse_value') !== null);
  assert.ok(L.fuzzyScore('parse', 'parse_value') !== null);
  assert.strictEqual(L.fuzzyScore('zz', 'parse_value'), null);
  assert.strictEqual(L.fuzzyScore('eslav', 'parse_value'), null,
    'order matters; letters out of order do not match');
});

test('fuzzyScore prefers exact, then prefix, then word-boundary matches', () => {
  const exact = L.fuzzyScore('free', 'free');
  const prefix = L.fuzzyScore('free', 'free_all');
  const boundary = L.fuzzyScore('free', 'arena_free');
  const scattered = L.fuzzyScore('free', 'frobnicate_reentry');
  assert.ok(exact > prefix, 'exact beats prefix');
  assert.ok(prefix > boundary, 'prefix beats a later word boundary');
  assert.ok(boundary > scattered, 'a word boundary beats a scattered match');
});

test('fuzzyScore is case insensitive', () => {
  assert.ok(L.fuzzyScore('JSON', 'json_parse') !== null);
  assert.ok(L.fuzzyScore('json', 'JSON_NULL') !== null);
});

test('an empty query scores neutrally rather than failing', () => {
  assert.strictEqual(L.fuzzyScore('', 'anything'), 0);
});

test('searchSymbols ranks the exact name first', () => {
  const p = L.buildProject([{ path: 'a.c', text:
    'void parse(void) { }\nvoid parse_value(void) { }\nvoid reparse_all(void) { }\n' }]);
  const hits = L.searchSymbols(p, 'parse', 10);
  assert.strictEqual(hits[0].symbol.name, 'parse');
  assert.ok(hits.length >= 3);
});

test('searchSymbols hides a prototype when the definition is in the project', () => {
  const p = L.buildProject([
    { path: 'a.h', text: 'int work(void);\n' },
    { path: 'a.c', text: 'int work(void) { return 1; }\n' }
  ]);
  const hits = L.searchSymbols(p, 'work', 10);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].symbol.file, 'a.c');
});

test('searchSymbols keeps a prototype when nothing defines it', () => {
  const p = L.buildProject([{ path: 'a.h', text: 'int external_thing(void);\n' }]);
  const hits = L.searchSymbols(p, 'external', 10);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].symbol.definition, false);
});

test('searchSymbols respects the result cap', () => {
  let text = '';
  for (let i = 0; i < 40; i++) text += 'void fn' + i + '(void) { }\n';
  const p = L.buildProject([{ path: 'a.c', text }]);
  assert.strictEqual(L.searchSymbols(p, 'fn', 5).length, 5);
});

/* ------------------------------------------------------------------ *
 * Input helpers
 * ------------------------------------------------------------------ */

test('isCSource accepts C and C++ extensions and rejects others', () => {
  ['a.c', 'a.h', 'b.cc', 'b.cpp', 'b.cxx', 'c.hpp', 'c.hh', 'c.hxx', 'd.inl', 'd.ipp']
    .forEach((n) => assert.ok(L.isCSource(n), n));
  ['a.txt', 'a.py', 'Makefile', 'a.cs', 'a.java', 'a.chh', 'a.c.bak']
    .forEach((n) => assert.ok(!L.isCSource(n), n));
});

test('isCSource is case insensitive', () => {
  assert.ok(L.isCSource('MAIN.C'));
  assert.ok(L.isCSource('Header.H'));
});

test('stripCommonPrefix removes a shared root directory', () => {
  assert.deepStrictEqual(
    L.stripCommonPrefix(['proj/src/a.c', 'proj/src/b.c', 'proj/inc/c.h']),
    ['src/a.c', 'src/b.c', 'inc/c.h']);
});

test('stripCommonPrefix leaves differing roots alone', () => {
  assert.deepStrictEqual(
    L.stripCommonPrefix(['one/a.c', 'two/b.c']),
    ['one/a.c', 'two/b.c']);
});

test('stripCommonPrefix reduces a single path to its basename', () => {
  assert.deepStrictEqual(L.stripCommonPrefix(['a/b/c/d.c']), ['d.c']);
});

test('stripCommonPrefix never strips a filename away entirely', () => {
  const out = L.stripCommonPrefix(['proj/a.c', 'proj/b.c']);
  assert.deepStrictEqual(out, ['a.c', 'b.c']);
  out.forEach((p) => assert.ok(p.length > 0));
});
