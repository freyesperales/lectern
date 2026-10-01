'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../core.js');

function project(files) {
  return L.buildProject(files);
}

function symbol(p, name, file) {
  return p.symbols.find((s) =>
    s.name === name && (file === undefined || s.file === file) &&
    (s.kind !== 'function' || s.definition));
}

function refsOf(p, name, file) {
  return symbol(p, name, file).refs;
}

function callTargets(p, name, file) {
  return refsOf(p, name, file)
    .filter((r) => r.relation === 'call')
    .map((r) => (r.targets.length ? p.symbols[r.targets[0]].name + '@' +
      p.symbols[r.targets[0]].file : r.name + '@?'));
}

test('a call to a function in the same file resolves to its definition', () => {
  const p = project([{ path: 'a.c', text:
    'int helper(void) { return 1; }\n' +
    'int caller(void) { return helper(); }\n' }]);
  assert.deepStrictEqual(callTargets(p, 'caller'), ['helper@a.c']);
});

test('a call resolves across files', () => {
  const p = project([
    { path: 'util.c', text: 'int helper(void) { return 1; }\n' },
    { path: 'main.c', text: 'int main(void) { return helper(); }\n' }
  ]);
  assert.deepStrictEqual(callTargets(p, 'main'), ['helper@util.c']);
});

test('a static definition shadows an external one of the same name', () => {
  const p = project([
    { path: 'shared.c', text: 'int helper(void) { return 1; }\n' },
    { path: 'local.c', text:
      'static int helper(void) { return 2; }\n' +
      'int use(void) { return helper(); }\n' }
  ]);
  assert.deepStrictEqual(callTargets(p, 'use', 'local.c'), ['helper@local.c']);
});

test('two statics with the same name in different files do not cross over', () => {
  const p = project([
    { path: 'one.c', text:
      'static int helper(void) { return 1; }\n' +
      'int a(void) { return helper(); }\n' },
    { path: 'two.c', text:
      'static int helper(void) { return 2; }\n' +
      'int b(void) { return helper(); }\n' }
  ]);
  assert.deepStrictEqual(callTargets(p, 'a', 'one.c'), ['helper@one.c']);
  assert.deepStrictEqual(callTargets(p, 'b', 'two.c'), ['helper@two.c']);
});

test('a definition is preferred over a bare prototype', () => {
  const p = project([
    { path: 'api.h', text: 'int work(int n);\n' },
    { path: 'api.c', text: 'int work(int n) { return n; }\n' },
    { path: 'use.c', text: '#include "api.h"\nint go(void) { return work(2); }\n' }
  ]);
  assert.deepStrictEqual(callTargets(p, 'go'), ['work@api.c']);
});

test('a call with no definition anywhere is left unresolved and reported', () => {
  const p = project([{ path: 'a.c', text:
    'int go(void) { return printf("hi"); }\n' }]);
  const call = refsOf(p, 'go').find((r) => r.name === 'printf');
  assert.deepStrictEqual(call.targets, []);
  assert.match(call.note, /not defined in this project/);
  assert.ok(p.unresolved.some((u) => u.name === 'printf' && u.count === 1));
});

test('unresolved names are counted and sorted by frequency', () => {
  const p = project([{ path: 'a.c', text:
    'void go(void) { free(0); free(0); malloc(1); }\n' }]);
  assert.deepStrictEqual(p.unresolved.map((u) => u.name + ':' + u.count),
    ['free:2', 'malloc:1']);
});

test('two external definitions of one name are reported as ambiguous', () => {
  const p = project([
    { path: 'one.c', text: 'int dup(void) { return 1; }\n' },
    { path: 'two.c', text: 'int dup(void) { return 2; }\n' },
    { path: 'use.c', text: 'int go(void) { return dup(); }\n' }
  ]);
  assert.ok(p.diagnostics.some((d) => /two external definitions of `dup`/.test(d.message)),
    JSON.stringify(p.diagnostics));
  const ref = refsOf(p, 'go').find((r) => r.name === 'dup');
  assert.strictEqual(ref.ambiguous, true);
  assert.strictEqual(ref.targets.length, 2);
});

test('a call through a struct member is marked indirect, not guessed', () => {
  const p = project([{ path: 'a.c', text:
    'struct ops { int (*read)(void); };\n' +
    'int read(void) { return 7; }\n' +
    'int go(struct ops *o) { return o->read(); }\n' }]);
  const ref = refsOf(p, 'go').find((r) => r.name === 'read');
  assert.strictEqual(ref.relation, 'indirect-call');
  assert.deepStrictEqual(ref.targets, []);
  assert.match(ref.note, /function pointer/);
});

test('a struct field access is not treated as a reference to a global', () => {
  const p = project([{ path: 'a.c', text:
    'int count;\n' +
    'struct bag { int count; };\n' +
    'int go(struct bag *b) { return b->count; }\n' }]);
  const hits = refsOf(p, 'go').filter((r) => r.name === 'count');
  assert.deepStrictEqual(hits, []);
});

test('control-flow keywords followed by a paren are not calls', () => {
  const p = project([{ path: 'a.c', text:
    'int go(int n) { if (n) { while (n) { n--; } } return sizeof(int); }\n' }]);
  assert.deepStrictEqual(refsOf(p, 'go').map((r) => r.name), []);
});

test('a local function-pointer declaration is not a call, and the call through it is not misattributed', () => {
  const p = project([{ path: 'a.c', text:
    'int target(void) { return 1; }\n' +
    'int go(void) { int (*fp)(void) = target; return fp(); }\n' }]);
  const calls = refsOf(p, 'go').filter((r) => r.relation === 'call');

  /* The declarator `(*fp)(void)` is not a call site at all. */
  assert.strictEqual(calls.filter((r) => r.name === 'fp').length, 1,
    'only the `fp()` invocation counts, not the declaration');

  /* `fp()` really is a call, but lectern cannot know what fp points at, so it
   * must be left unresolved rather than linked to `target`. */
  const fp = calls.find((r) => r.name === 'fp');
  assert.deepStrictEqual(fp.targets, []);
  assert.ok(p.unresolved.some((u) => u.name === 'fp'));
  const target = symbol(p, 'target');
  assert.ok(!p.out[symbol(p, 'go').id].includes(target.id),
    'go must not be recorded as calling target');
});

test("a function's own name in its signature is not a recursive call", () => {
  const p = project([{ path: 'a.c', text:
    'int go(int n) { return n; }\n' }]);
  assert.deepStrictEqual(refsOf(p, 'go').filter((r) => r.name === 'go'), []);
});

test('types in the parameter list and return type are resolved', () => {
  const p = project([{ path: 'a.c', text:
    'struct in { int a; };\nstruct out { int b; };\n' +
    'struct out *convert(struct in *src) { return 0; }\n' }]);
  const names = refsOf(p, 'convert')
    .filter((r) => r.relation === 'type')
    .map((r) => r.name);
  assert.ok(names.includes('in'), names.join(' '));
  assert.ok(names.includes('out'), names.join(' '));
});

test('a type reference resolves to the aggregate that defines it', () => {
  const p = project([{ path: 'a.c', text:
    'struct point { int x; };\n' +
    'int go(struct point *p) { return p->x; }\n' }]);
  const ref = refsOf(p, 'go').find((r) => r.relation === 'type');
  assert.strictEqual(ref.name, 'point');
  assert.strictEqual(p.symbols[ref.targets[0]].kind, 'struct');
});

test('a typedef name used in a body resolves to the typedef', () => {
  const p = project([{ path: 'a.c', text:
    'typedef struct { int a; } Widget;\n' +
    'int go(void) { Widget w; return w.a; }\n' }]);
  const ref = refsOf(p, 'go').find((r) => r.name === 'Widget');
  assert.strictEqual(ref.relation, 'type');
  assert.ok(ref.targets.length >= 1);
});

test('a macro used in a body is recorded as a macro reference', () => {
  const p = project([{ path: 'a.c', text:
    '#define LIMIT 10\n' +
    'int go(int n) { return n > LIMIT; }\n' }]);
  const ref = refsOf(p, 'go').find((r) => r.name === 'LIMIT');
  assert.strictEqual(ref.relation, 'macro');
  assert.strictEqual(p.symbols[ref.targets[0]].kind, 'macro');
});

test('a function-like macro invocation is recorded as a call', () => {
  const p = project([{ path: 'a.c', text:
    '#define MAX(a, b) ((a) > (b) ? (a) : (b))\n' +
    'int go(int x) { return MAX(x, 3); }\n' }]);
  const ref = refsOf(p, 'go').find((r) => r.name === 'MAX');
  assert.strictEqual(ref.relation, 'call');
  assert.strictEqual(p.symbols[ref.targets[0]].kind, 'macro');
});

test('reading a file-scope variable is recorded', () => {
  const p = project([{ path: 'a.c', text:
    'static int tally;\n' +
    'void bump(void) { tally++; }\n' }]);
  const ref = refsOf(p, 'bump').find((r) => r.name === 'tally');
  assert.strictEqual(ref.relation, 'reads');
});

test('every call site is kept separately so each can be opened', () => {
  const p = project([{ path: 'a.c', text:
    'int h(void) { return 1; }\n' +
    'int go(void) { return h() + h() + h(); }\n' }]);
  const calls = refsOf(p, 'go').filter((r) => r.name === 'h');
  assert.strictEqual(calls.length, 3);
  const lines = new Set(calls.map((c) => c.tokenFull));
  assert.strictEqual(lines.size, 3, 'each site has its own token position');
});

test('the graph deduplicates repeated calls into one edge', () => {
  const p = project([{ path: 'a.c', text:
    'int h(void) { return 1; }\n' +
    'int go(void) { return h() + h() + h(); }\n' }]);
  const go = symbol(p, 'go');
  const h = symbol(p, 'h');
  assert.deepStrictEqual(p.out[go.id].filter((t) => t === h.id).length, 1);
  assert.ok(p.in[h.id].includes(go.id));
});

test('self recursion is not a graph edge but is still a visible call site', () => {
  const p = project([{ path: 'a.c', text:
    'int fact(int n) { return n < 2 ? 1 : n * fact(n - 1); }\n' }]);
  const fact = symbol(p, 'fact');
  assert.ok(!p.out[fact.id].includes(fact.id), 'no self edge in the graph');
  assert.ok(refsOf(p, 'fact').some((r) => r.name === 'fact' && r.relation === 'call'),
    'the recursive call is still shown in the text');
});

test('callersOf lists each caller once with every call site line', () => {
  const p = project([{ path: 'a.c', text:
    'int h(void) { return 1; }\n' +
    'int one(void) { return h(); }\n' +
    'int two(void) {\n  h();\n  return h();\n}\n' }]);
  const callers = L.callersOf(p, symbol(p, 'h').id);
  assert.deepStrictEqual(callers.map((c) => c.symbol.name), ['one', 'two']);
  assert.deepStrictEqual(callers[1].sites.map((s) => s.line), [4, 5]);
});

test('lookup honours the requested kinds', () => {
  const p = project([{ path: 'a.c', text:
    'int thing;\nint thing_fn(void) { return 0; }\n' }]);
  assert.ok(L.lookup(p, 'thing', 'a.c', ['variable']));
  assert.strictEqual(L.lookup(p, 'thing', 'a.c', ['function']), null);
});

test('an empty project builds without throwing', () => {
  const p = project([]);
  assert.deepStrictEqual(p.symbols, []);
  assert.deepStrictEqual(p.readingOrder.sequence, []);
  assert.strictEqual(L.stats(p).files, 0);
});
