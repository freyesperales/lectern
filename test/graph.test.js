'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../core.js');

/* ------------------------------------------------------------------ *
 * Tarjan, against hand-checked graphs
 * ------------------------------------------------------------------ */

function componentSets(adj) {
  const r = L.tarjan(adj);
  return r.groups
    .map((g) => g.slice().sort((a, b) => a - b).join(','))
    .sort();
}

test('a graph with no edges is all singletons', () => {
  assert.deepStrictEqual(componentSets([[], [], []]), ['0', '1', '2']);
});

test('a chain is all singletons', () => {
  assert.deepStrictEqual(componentSets([[1], [2], []]), ['0', '1', '2']);
});

test('a two-cycle is one component', () => {
  assert.deepStrictEqual(componentSets([[1], [0]]), ['0,1']);
});

test('a three-cycle with a tail splits correctly', () => {
  /* 0 -> 1 -> 2 -> 0, and 2 -> 3 */
  assert.deepStrictEqual(componentSets([[1], [2], [0, 3], []]), ['0,1,2', '3']);
});

test('two disjoint cycles stay separate', () => {
  assert.deepStrictEqual(componentSets([[1], [0], [3], [2]]), ['0,1', '2,3']);
});

test('nested cycles sharing a node merge into one component', () => {
  /* 0->1->0 and 1->2->1 share node 1, so all three are mutually reachable. */
  assert.deepStrictEqual(componentSets([[1], [0, 2], [1]]), ['0,1,2']);
});

test('a self loop alone is still one component', () => {
  assert.deepStrictEqual(componentSets([[0]]), ['0']);
});

test('every node lands in exactly one component', () => {
  const adj = [[1, 2], [2], [0, 3], [4], [5], [3], [], [6]];
  const r = L.tarjan(adj);
  const seen = new Set();
  r.groups.forEach((g) => g.forEach((n) => {
    assert.ok(!seen.has(n), 'node ' + n + ' appeared twice');
    seen.add(n);
  }));
  assert.strictEqual(seen.size, adj.length);
  for (let i = 0; i < adj.length; i++) {
    assert.ok(r.groups[r.comp[i]].includes(i), 'comp[] disagrees with groups[]');
  }
});

test('components are emitted in reverse topological order', () => {
  /* 0 -> 1 -> 2: Tarjan closes sinks first, so 2 precedes 1 precedes 0. */
  const r = L.tarjan([[1], [2], []]);
  assert.ok(r.comp[2] < r.comp[1], 'the sink closes first');
  assert.ok(r.comp[1] < r.comp[0]);
});

test('a long chain does not overflow the stack', () => {
  const n = 60000;
  const adj = [];
  for (let i = 0; i < n; i++) adj.push(i + 1 < n ? [i + 1] : []);
  const r = L.tarjan(adj);
  assert.strictEqual(r.groups.length, n);
});

test('a long cycle does not overflow the stack', () => {
  const n = 40000;
  const adj = [];
  for (let i = 0; i < n; i++) adj.push([(i + 1) % n]);
  const r = L.tarjan(adj);
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.groups[0].length, n);
});

/* ------------------------------------------------------------------ *
 * Reading order
 * ------------------------------------------------------------------ */

function order(files) {
  const p = L.buildProject(files);
  const pos = new Map();
  p.readingOrder.sequence.forEach((id, i) => pos.set(id, i));
  return { p, pos, names: p.readingOrder.sequence.map((id) => p.symbols[id].name) };
}

test('callees are read before their callers', () => {
  const { names } = order([{ path: 'a.c', text:
    'void leaf(void) { }\n' +
    'void middle(void) { leaf(); }\n' +
    'void top(void) { middle(); }\n' }]);
  assert.deepStrictEqual(names, ['leaf', 'middle', 'top']);
});

test('order is independent of the order the source happens to be written in', () => {
  const { names } = order([{ path: 'a.c', text:
    'void top(void);\nvoid middle(void);\n' +
    'void top(void) { middle(); }\n' +
    'void middle(void) { leaf2(); }\n' +
    'void leaf2(void) { }\n' }]);
  const pos = (n) => names.indexOf(n);
  assert.ok(pos('leaf2') < pos('middle'), names.join(' '));
  assert.ok(pos('middle') < pos('top'), names.join(' '));
});

test('a type is read before the function that uses it', () => {
  const { names } = order([{ path: 'a.c', text:
    'int use(struct thing *t) { return 0; }\n' +
    'struct thing { int x; };\n' }]);
  assert.ok(names.indexOf('thing') < names.indexOf('use'), names.join(' '));
});

test('a macro is read before the function that uses it', () => {
  const { names } = order([{ path: 'a.c', text:
    'int use(int n) { return n + CAP; }\n' +
    '#define CAP 5\n' }]);
  assert.ok(names.indexOf('CAP') < names.indexOf('use'), names.join(' '));
});

test('define-before-use holds for every edge except the reported back edges', () => {
  const { p, pos } = order([
    { path: 'a.c', text:
      '#define N 4\n' +
      'struct box { int v; };\n' +
      'static int ping(int n);\n' +
      'static int pong(int n) { return n > 0 ? ping(n - 1) : 0; }\n' +
      'static int ping(int n) { return n > 0 ? pong(n - 1) : N; }\n' +
      'int run(struct box *b) { return ping(b->v); }\n' },
    { path: 'b.c', text:
      'int other(void) { return 1; }\n' }
  ]);
  const reported = new Set(
    p.readingOrder.backEdges.map((e) => e.from + '->' + e.to));

  let checked = 0;
  p.symbols.forEach((s) => {
    const from = pos.get(s.id);
    p.out[s.id].forEach((t) => {
      const to = pos.get(t);
      checked++;
      if (to > from) {
        assert.ok(reported.has(s.id + '->' + t),
          'forward reference ' + s.name + ' -> ' + p.symbols[t].name +
          ' was not reported as a back edge');
      }
    });
  });
  assert.ok(checked > 0, 'the fixture must actually have edges');
});

test('mutual recursion is reported as one cycle whose members sit together', () => {
  const { p, pos } = order([{ path: 'a.c', text:
    'static int ping(int n);\n' +
    'static int pong(int n) { return ping(n - 1); }\n' +
    'static int ping(int n) { return pong(n - 1); }\n' }]);
  assert.strictEqual(p.readingOrder.cycles.length, 1);
  const members = p.readingOrder.cycles[0].map((id) => p.symbols[id].name).sort();
  assert.deepStrictEqual(members, ['ping', 'pong']);
  const positions = p.readingOrder.cycles[0].map((id) => pos.get(id)).sort((a, b) => a - b);
  assert.strictEqual(positions[1] - positions[0], 1, 'cycle members are adjacent');
});

test('an acyclic project reports no cycles and no back edges', () => {
  const { p } = order([{ path: 'a.c', text:
    'void leaf(void) { }\nvoid top(void) { leaf(); }\n' }]);
  assert.deepStrictEqual(p.readingOrder.cycles, []);
  assert.deepStrictEqual(p.readingOrder.backEdges, []);
});

test('the sequence contains every symbol exactly once', () => {
  const { p } = order([
    { path: 'a.c', text:
      '#define M 1\ntypedef int I;\nstruct s { int x; };\n' +
      'static int v;\nint f(void) { return v + M; }\nint g(I x);\n' },
    { path: 'b.c', text: 'int h(void) { return f(); }\n' }
  ]);
  const seq = p.readingOrder.sequence;
  assert.strictEqual(seq.length, p.symbols.length);
  assert.strictEqual(new Set(seq).size, p.symbols.length);
});

test('self recursion alone does not create a cycle group', () => {
  const { p } = order([{ path: 'a.c', text:
    'int fact(int n) { return n < 2 ? 1 : n * fact(n - 1); }\n' }]);
  assert.deepStrictEqual(p.readingOrder.cycles, []);
});

/* ------------------------------------------------------------------ *
 * Call tree
 * ------------------------------------------------------------------ */

function tree(files, rootName, depth) {
  const p = L.buildProject(files);
  const root = p.symbols.find((s) => s.name === rootName && s.definition);
  return { p, t: L.callTree(p, root.id, depth) };
}

test('the call tree follows calls and stops at leaves', () => {
  const { t } = tree([{ path: 'a.c', text:
    'void leaf(void) { }\n' +
    'void middle(void) { leaf(); }\n' +
    'void top(void) { middle(); }\n' }], 'top', 4);
  assert.strictEqual(t.symbol.name, 'top');
  assert.strictEqual(t.children.length, 1);
  assert.strictEqual(t.children[0].symbol.name, 'middle');
  assert.strictEqual(t.children[0].children[0].symbol.name, 'leaf');
  assert.deepStrictEqual(t.children[0].children[0].children, []);
});

test('the call tree marks a cycle instead of recursing forever', () => {
  const { t } = tree([{ path: 'a.c', text:
    'void a(void);\nvoid b(void) { a(); }\nvoid a(void) { b(); }\n' }], 'a', 10);
  let node = t;
  let hops = 0;
  while (node.children.length && hops < 20) { node = node.children[0]; hops++; }
  assert.ok(node.cycle, 'the walk ends on a node marked as a cycle');
  assert.ok(hops < 5, 'it stops as soon as the path repeats, after ' + hops + ' hops');
});

test('the call tree flags truncation at the depth limit', () => {
  const { t } = tree([{ path: 'a.c', text:
    'void d(void) { }\nvoid c(void) { d(); }\n' +
    'void b(void) { c(); }\nvoid a(void) { b(); }\n' }], 'a', 2);
  assert.strictEqual(t.children[0].children[0].symbol.name, 'c');
  assert.strictEqual(t.children[0].children[0].truncated, true,
    'c has a callee that is not shown');
});

test('the call tree only follows calls, not type or macro references', () => {
  const { t } = tree([{ path: 'a.c', text:
    '#define K 2\nstruct s { int x; };\n' +
    'void go(struct s *p) { int n = K; (void)n; (void)p; }\n' }], 'go', 4);
  assert.deepStrictEqual(t.children, []);
});

test('a macro invocation does not appear as a child function in the call tree', () => {
  const { t } = tree([{ path: 'a.c', text:
    '#define MAX(a, b) ((a) > (b) ? (a) : (b))\n' +
    'int real(void) { return 1; }\n' +
    'int go(void) { return MAX(real(), 2); }\n' }], 'go', 4);
  assert.deepStrictEqual(t.children.map((c) => c.symbol.name), ['real']);
});
