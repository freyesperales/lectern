'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../core.js');

/** Join every token back together; must equal the input byte for byte. */
function roundTrip(src) {
  return L.tokenize(src).tokens.map((t) => t.v).join('');
}

function kinds(src) {
  return L.tokenize(src).tokens
    .filter((t) => !L.isTrivia(t))
    .map((t) => t.k + ':' + t.v);
}

test('every byte lands in exactly one token', () => {
  const samples = [
    '',
    'int x;',
    'int x;\n',
    '\n\n\n',
    '\r\n\r\n',
    'a\tb  c',
    '/* block */ int /* mid */ y;',
    '// trailing\nint z;',
    '"a\\"b" \'\\n\' 0x1Fu 1e-5 .5f',
    '#define A(x) ((x) + 1)\n',
    'int f(void)\n{\n\treturn 1;\n}\n',
    '\\\n',
    'int \\\n  x;',
    '/* unterminated',
    '"unterminated',
    'char c = \'\\\\\';',
    'x->y.z(1);',
    '\u00e9\u00fc identifier_with_latin1',
    '@ ` $ \\ ?',
  ];
  for (const s of samples) {
    assert.strictEqual(roundTrip(s), s, JSON.stringify(s));
  }
});

test('comments are single tokens and do not swallow the newline', () => {
  const t = L.tokenize('// hi\nint x;').tokens;
  assert.strictEqual(t[0].k, 'comment');
  assert.strictEqual(t[0].v, '// hi');
  assert.strictEqual(t[1].k, 'nl');
});

test('a block comment spanning lines keeps the starting line number', () => {
  const t = L.tokenize('int a;\n/* one\n   two */\nint b;').tokens;
  const comment = t.find((x) => x.k === 'comment');
  assert.strictEqual(comment.line, 2);
  const last = t.filter((x) => x.k === 'ident').pop();
  assert.strictEqual(last.v, 'b');
  assert.strictEqual(last.line, 4);
});

test('an unterminated block comment is reported, not thrown', () => {
  const r = L.tokenize('int a;\n/* never closed\nint b;');
  assert.strictEqual(r.diagnostics.length, 1);
  assert.match(r.diagnostics[0].message, /unterminated block comment/);
  assert.strictEqual(r.diagnostics[0].line, 2);
});

test('a // comment continued by a backslash covers both lines', () => {
  const src = '// first \\\nstill comment\nint x;';
  const t = L.tokenize(src).tokens;
  const comment = t.find((x) => x.k === 'comment');
  assert.ok(comment.v.includes('still comment'), comment.v);
  const id = t.filter((x) => x.k === 'ident');
  assert.deepStrictEqual(id.map((x) => x.v), ['x']);
});

test('string and character literals handle escapes', () => {
  assert.deepStrictEqual(kinds('"a\\"b"'), ['string:"a\\"b"']);
  assert.deepStrictEqual(kinds("'\\''"), ["char:'\\''"]);
  assert.deepStrictEqual(kinds('"\\\\"'), ['string:"\\\\"']);
});

test('unterminated literals are reported', () => {
  const s = L.tokenize('char *p = "oops;\n');
  assert.ok(s.diagnostics.some((d) => /unterminated string/.test(d.message)));
  const c = L.tokenize("char q = 'a;\n");
  assert.ok(c.diagnostics.some((d) => /unterminated character/.test(d.message)));
});

test('pp-numbers absorb suffixes and exponents but not plain arithmetic', () => {
  assert.deepStrictEqual(kinds('0x1Fu'), ['number:0x1Fu']);
  assert.deepStrictEqual(kinds('1e-5'), ['number:1e-5']);
  assert.deepStrictEqual(kinds('0x1p+3'), ['number:0x1p+3']);
  assert.deepStrictEqual(kinds('1.5f'), ['number:1.5f']);
  assert.deepStrictEqual(kinds('a-5'), ['ident:a', 'punct:-', 'number:5']);
  assert.deepStrictEqual(kinds('3-x'), ['number:3', 'punct:-', 'ident:x']);
});

test('keywords are distinguished from identifiers', () => {
  const t = L.tokenize('static int myint;').tokens.filter((x) => !L.isTrivia(x));
  assert.deepStrictEqual(t.map((x) => x.k), ['keyword', 'keyword', 'ident', 'punct']);
});

test('punctuators prefer the longest match', () => {
  assert.deepStrictEqual(kinds('a<<=b'), ['ident:a', 'punct:<<=', 'ident:b']);
  assert.deepStrictEqual(kinds('p->q'), ['ident:p', 'punct:->', 'ident:q']);
  assert.deepStrictEqual(kinds('a<b'), ['ident:a', 'punct:<', 'ident:b']);
});

test('a hash is a directive only at the start of a logical line', () => {
  const direct = L.tokenize('#define X 1\n').tokens;
  assert.strictEqual(direct[0].k, 'hash');
  assert.ok(direct[0].pp);

  const indented = L.tokenize('  #include <x.h>\n').tokens;
  assert.ok(indented.some((t) => t.k === 'hash' && t.pp));

  /* After real code on the same line, `#` is just a punctuator. */
  const mid = L.tokenize('int x = a # b;\n').tokens;
  assert.ok(mid.every((t) => t.k !== 'hash'));
});

test('a continued directive stays marked as preprocessor across lines', () => {
  const t = L.tokenize('#define LONG(a) \\\n    do { f(a); } while (0)\nint x;').tokens;
  const whileTok = t.find((x) => x.v === 'while');
  assert.ok(whileTok.pp, 'the continued line is still part of the directive');
  const xTok = t.filter((x) => x.k === 'ident').pop();
  assert.strictEqual(xTok.v, 'x');
  assert.ok(!xTok.pp, 'the line after the directive is ordinary code');
});

test('line numbers survive a continuation inside a string literal', () => {
  /* Four physical lines: the backslash-newline inside the literal is one. */
  const src = 'int a;\nchar *s = "x\\\ny";\nint b;\n';
  assert.strictEqual(src.split('\n').length - 1, 3, 'three newlines in the fixture');
  const t = L.tokenize(src).tokens;
  const b = t.filter((x) => x.k === 'ident').pop();
  assert.strictEqual(b.v, 'b');
  assert.strictEqual(b.line, 4);
});

test('token offsets point at the start of the token, not the end', () => {
  const src = 'int  add(void);';
  const t = L.tokenize(src).tokens;
  t.forEach((tok) => {
    assert.strictEqual(src.slice(tok.i, tok.i + tok.v.length), tok.v,
      'token ' + JSON.stringify(tok.v) + ' at offset ' + tok.i);
  });
  /* And the offsets tile the input with no gaps. */
  let cursor = 0;
  t.forEach((tok) => {
    assert.strictEqual(tok.i, cursor);
    cursor += tok.v.length;
  });
  assert.strictEqual(cursor, src.length);
});

test('matchDelim finds the balanced partner', () => {
  const t = L.tokenize('f(a, g(b), c)').tokens;
  const open = t.findIndex((x) => x.v === '(');
  const close = L.matchDelim(t, open, '(', ')');
  assert.strictEqual(t[close].v, ')');
  assert.strictEqual(close, t.length - 1);
  assert.strictEqual(L.matchDelim(L.tokenize('f(a').tokens, 1, '(', ')'), -1);
});
