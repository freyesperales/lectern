'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../core.js');

function idx(src) {
  return L.indexFile('t.c', src);
}

function names(src, kind) {
  return idx(src).symbols
    .filter((s) => kind === undefined || s.kind === kind)
    .map((s) => s.name);
}

function find(src, name) {
  return idx(src).symbols.find((s) => s.name === name);
}

test('a function definition is found with its name, line and body', () => {
  const src = 'int add(int a, int b)\n{\n    return a + b;\n}\n';
  const f = find(src, 'add');
  assert.strictEqual(f.kind, 'function');
  assert.strictEqual(f.definition, true);
  assert.strictEqual(f.line, 1);
  assert.strictEqual(f.static, false);
  assert.strictEqual(f.signature, 'int add(int a, int b)');
  assert.ok(f.bodyStart >= 0 && f.bodyEnd > f.bodyStart);
});

test('the declarator is the name next to the parameter list, not the type', () => {
  assert.deepStrictEqual(names('struct hdr *parse_hdr(const char *s) { return 0; }',
    'function'), ['parse_hdr']);
  assert.deepStrictEqual(names('static unsigned long **weird(void) { return 0; }',
    'function'), ['weird']);
});

test('prototypes and definitions are told apart', () => {
  const r = idx('int f(void);\nint f(void) { return 0; }\n');
  const fns = r.symbols.filter((s) => s.kind === 'function');
  assert.strictEqual(fns.length, 2);
  assert.deepStrictEqual(fns.map((s) => s.definition), [false, true]);
});

test('static linkage is recorded', () => {
  assert.strictEqual(find('static void helper(void) { }', 'helper').static, true);
  assert.strictEqual(find('void helper(void) { }', 'helper').static, false);
});

test('struct, union and enum definitions are indexed with their bodies', () => {
  const r = idx(
    'struct point { int x; int y; };\n' +
    'union box { int i; float f; };\n' +
    'enum color { RED, GREEN };\n');
  assert.deepStrictEqual(r.symbols.map((s) => s.kind + ' ' + s.name),
    ['struct point', 'union box', 'enum color']);
  r.symbols.forEach((s) => assert.ok(s.bodyEnd > s.bodyStart, s.name));
});

test('typedef of an anonymous struct is named by its alias', () => {
  const r = idx('typedef struct { int a; } Widget;\n');
  const kinds = r.symbols.map((s) => s.kind + ':' + s.name);
  assert.ok(kinds.includes('struct:Widget'), kinds.join(' '));
  assert.ok(kinds.includes('typedef:Widget'), kinds.join(' '));
});

test('typedef of a tagged struct records both the tag and the alias', () => {
  const r = idx('typedef struct node { int v; } Node;\n');
  const byKind = r.symbols.map((s) => s.kind + ':' + s.name);
  assert.ok(byKind.includes('struct:node'), byKind.join(' '));
  assert.ok(byKind.includes('typedef:Node'), byKind.join(' '));
});

test('a function-pointer typedef is named by the inner identifier', () => {
  assert.deepStrictEqual(
    names('typedef int (*compare_fn)(const void *, const void *);', 'typedef'),
    ['compare_fn']);
});

test('a plain typedef takes the trailing name', () => {
  assert.deepStrictEqual(names('typedef unsigned long long u64;', 'typedef'), ['u64']);
  assert.deepStrictEqual(names('typedef struct arena Arena;', 'typedef'), ['Arena']);
});

test('a forward declaration does not shadow the real definition', () => {
  const r = idx('struct node;\nstruct node { int v; };\n');
  const structs = r.symbols.filter((s) => s.kind === 'struct');
  assert.strictEqual(structs.length, 1);
  assert.ok(structs[0].bodyEnd > structs[0].bodyStart);
});

test('object-like and function-like macros are distinguished', () => {
  const r = idx('#define SIZE 64\n#define MAX(a, b) ((a) > (b) ? (a) : (b))\n#define GLUED (1)\n');
  const macros = r.symbols.filter((s) => s.kind === 'macro');
  assert.deepStrictEqual(macros.map((m) => m.name), ['SIZE', 'MAX', 'GLUED']);
  assert.strictEqual(macros[0].funcLike, false);
  assert.strictEqual(macros[1].funcLike, true);
  /* `#define GLUED (1)` has a space before `(`, so it is object-like. */
  assert.strictEqual(macros[2].funcLike, false);
});

test('includes are collected and system headers flagged', () => {
  const r = idx('#include <stdio.h>\n#include "local.h"\n');
  assert.deepStrictEqual(r.includes.map((i) => i.target), ['stdio.h', 'local.h']);
  assert.deepStrictEqual(r.includes.map((i) => i.system), [true, false]);
});

test('file-scope variables are indexed, including arrays and initialisers', () => {
  assert.deepStrictEqual(names('int counter;', 'variable'), ['counter']);
  assert.deepStrictEqual(names('static int table[8] = { 0 };', 'variable'), ['table']);
  assert.deepStrictEqual(names('int a, b, c;', 'variable'), ['a', 'b', 'c']);
  assert.deepStrictEqual(names('struct point origin;', 'variable'), ['origin']);
});

test('an initialiser containing braces and semicolons does not derail the scan', () => {
  const r = idx(
    'static const char *names[] = { "a;b", "c}d" };\n' +
    'int after(void) { return 1; }\n');
  assert.deepStrictEqual(r.symbols.map((s) => s.name), ['names', 'after']);
});

test('a struct holding a function pointer is not mistaken for a function', () => {
  const r = idx('struct ops { int (*read)(void *, char *, int); };\nint go(void) { return 0; }\n');
  assert.deepStrictEqual(r.symbols.map((s) => s.kind + ':' + s.name),
    ['struct:ops', 'function:go']);
});

test('the declaration right after a function body is still found', () => {
  const r = idx('void a(void) { }\nvoid b(void) { }\nint c;\n');
  assert.deepStrictEqual(r.symbols.map((s) => s.name), ['a', 'b', 'c']);
});

test('a doc comment above a symbol is attached to it', () => {
  const f = find('/* Adds two numbers. */\nint add(int a, int b) { return a + b; }', 'add');
  assert.match(f.doc, /Adds two numbers/);
});

test('a comment separated by a blank line is not attached', () => {
  const f = find('/* unrelated note */\n\nint add(int a, int b) { return a + b; }', 'add');
  assert.strictEqual(f.doc, '');
});

test('an extern "C" wrapper is stepped into rather than skipped', () => {
  const r = idx('extern "C" {\nint wrapped(void) { return 1; }\n}\n');
  assert.ok(r.symbols.some((s) => s.name === 'wrapped' && s.kind === 'function'),
    r.symbols.map((s) => s.name).join(' '));
});

test('a directive in the middle of a declaration does not lose the declaration', () => {
  const r = idx('int f(\n#ifdef X\n  int a\n#endif\n) { return 0; }\n');
  assert.ok(r.symbols.some((s) => s.name === 'f'), r.symbols.map((s) => s.name).join(' '));
});

test('indexing an empty or comment-only file yields nothing and does not throw', () => {
  assert.deepStrictEqual(idx('').symbols, []);
  assert.deepStrictEqual(idx('/* just a note */\n').symbols, []);
  assert.deepStrictEqual(idx('\n\n\n').symbols, []);
});

test('line counting matches the number of lines a reader sees', () => {
  assert.strictEqual(L.countLines(''), 0);
  assert.strictEqual(L.countLines('a'), 1);
  assert.strictEqual(L.countLines('a\n'), 2);
  assert.strictEqual(L.countLines('a\nb'), 2);
});

test('normalizeSignature collapses comments and whitespace', () => {
  assert.strictEqual(
    L.normalizeSignature('int  f(/* n */ int\n  a)'),
    'int f( int a)');
});
