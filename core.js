/*
 * lectern/core.js -- the reading engine.
 *
 * A dependency-free C indexer: tokenizer -> declaration index -> reference
 * resolver -> dependency graph -> reading order.
 *
 * Loaded two ways, with no build step in either:
 *   browser  <script src="core.js"></script>   (classic script, works on file://)
 *   node     require('./core.js')              (CommonJS, for `node --test`)
 *
 * No DOM access anywhere in this file. Everything here is pure data in, pure
 * data out, which is why the whole thing is testable from node.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Lectern = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ===================================================================== *
   * 1. Tokenizer
   * ===================================================================== *
   *
   * Full-coverage lexer: every byte of the input ends up in exactly one
   * token, so joining every token's `v` reproduces the source exactly. The
   * syntax highlighter and the indexer both read the same token stream, which
   * means the thing you see highlighted is literally the thing that was
   * indexed -- there is no second, divergent regex-based highlighter.
   *
   * Token kinds:
   *   ws cont nl comment string char number ident keyword punct hash
   * Tokens on a preprocessor logical line carry `pp: true`.
   */

  var C_KEYWORDS = new Set([
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
    'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if',
    'inline', 'int', 'long', 'register', 'restrict', 'return', 'short',
    'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
    'unsigned', 'void', 'volatile', 'while',
    '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex', '_Generic',
    '_Imaginary', '_Noreturn', '_Static_assert', '_Thread_local',
    'alignas', 'alignof', 'bool', 'static_assert', 'thread_local',
    'true', 'false', 'nullptr', 'typeof'
  ]);

  /* Keywords that can be followed by `(` without being a function call. */
  var NOT_CALLABLE = new Set([
    'if', 'while', 'for', 'switch', 'return', 'sizeof', 'catch',
    '_Generic', '_Alignof', 'alignof', 'alignas', '_Alignas', 'typeof',
    '_Static_assert', 'static_assert', 'defined', 'do', 'else', 'case',
    'goto', 'break', 'continue', 'default', 'and', 'or', 'not'
  ]);

  /* Type specifier keywords -- used to tell declarations from expressions. */
  var TYPE_WORDS = new Set([
    'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed',
    'unsigned', 'bool', '_Bool', '_Complex', '_Imaginary', 'struct', 'union',
    'enum', 'const', 'volatile', 'restrict', 'static', 'extern', 'inline',
    'register', 'auto', 'typedef', '_Atomic', '_Noreturn', '_Thread_local',
    'thread_local'
  ]);

  /* Longest-first so that `<<=` wins over `<<` which wins over `<`. */
  var PUNCT = [
    '%:%:', '...', '<<=', '>>=', '->*', '<=>',
    '::', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##', '<:', ':>', '<%',
    '%>', '%:', '.*',
    '{', '}', '[', ']', '(', ')', ';', ':', '?', '.', '+', '-', '*', '/',
    '%', '^', '&', '|', '~', '!', '=', '<', '>', ',', '#', '@', '$', '\\', '`'
  ];

  function isIdentStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' ||
      c === '$' || c.charCodeAt(0) > 127;
  }
  function isIdentPart(c) {
    return isIdentStart(c) || (c >= '0' && c <= '9');
  }
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isSpace(c) { return c === ' ' || c === '\t' || c === '\f' || c === '\v'; }

  /**
   * Lex C source into a full-coverage token array.
   * @param {string} src
   * @returns {{tokens: Array, diagnostics: Array}}
   */
  function tokenize(src) {
    var tokens = [];
    var diagnostics = [];
    var n = src.length;
    var i = 0;
    var line = 1;
    /* True once we have seen a `#` that begins a preprocessor logical line,
     * until that logical line ends (respecting backslash continuations). */
    var inPP = false;
    /* True while nothing but whitespace/comments has been seen on this
     * logical line -- i.e. a `#` here starts a directive. */
    var atLineStart = true;

    /* `start` is the loop-local (var-scoped, so visible here) offset at which
     * the current token began; `i` has already been advanced past it. */
    function push(k, v, startLine) {
      var t = { k: k, v: v, i: start, line: startLine === undefined ? line : startLine };
      if (inPP) t.pp = true;
      tokens.push(t);
    }

    while (i < n) {
      var c = src[i];
      var start = i;
      var startLine = line;

      /* --- newline: ends a preprocessor logical line --- */
      if (c === '\n' || c === '\r') {
        var nl = c;
        i++;
        if (c === '\r' && src[i] === '\n') { nl += '\n'; i++; }
        tokens.push({ k: 'nl', v: nl, i: start, line: startLine, pp: inPP || undefined });
        line++;
        inPP = false;
        atLineStart = true;
        continue;
      }

      /* --- line continuation: backslash immediately before a newline --- */
      if (c === '\\') {
        var j = i + 1;
        while (j < n && isSpace(src[j])) j++;
        if (j < n && (src[j] === '\n' || src[j] === '\r')) {
          var end = j + 1;
          if (src[j] === '\r' && src[end] === '\n') end++;
          push('cont', src.slice(i, end), startLine);
          i = end;
          line++;
          /* A continued line keeps the preprocessor state alive and is NOT a
           * fresh logical line start. */
          continue;
        }
      }

      /* --- horizontal whitespace --- */
      if (isSpace(c)) {
        while (i < n && isSpace(src[i])) i++;
        push('ws', src.slice(start, i), startLine);
        continue;
      }

      /* --- comments --- */
      if (c === '/' && src[i + 1] === '/') {
        /* A // comment runs to the newline, but a backslash continuation
         * extends it onto the next physical line. */
        i += 2;
        while (i < n) {
          if (src[i] === '\\') {
            var k2 = i + 1;
            while (k2 < n && isSpace(src[k2])) k2++;
            if (k2 < n && (src[k2] === '\n' || src[k2] === '\r')) {
              i = k2 + 1;
              if (src[k2] === '\r' && src[i] === '\n') i++;
              line++;
              continue;
            }
          }
          if (src[i] === '\n' || src[i] === '\r') break;
          i++;
        }
        push('comment', src.slice(start, i), startLine);
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        var closed = false;
        while (i < n) {
          if (src[i] === '*' && src[i + 1] === '/') { i += 2; closed = true; break; }
          if (src[i] === '\n') line++;
          i++;
        }
        if (!closed) {
          diagnostics.push({
            severity: 'warn', line: startLine,
            message: 'unterminated block comment; treated as running to end of file'
          });
        }
        push('comment', src.slice(start, i), startLine);
        continue;
      }

      /* --- string / char literals (including u8"" u"" U"" L"" prefixes,
       *     which lex as a separate ident token -- harmless) --- */
      if (c === '"' || c === '\'') {
        var quote = c;
        i++;
        var term = false;
        while (i < n) {
          var d = src[i];
          if (d === '\\') {
            /* Escape: skip the backslash and whatever follows, counting any
             * newline so line numbers stay correct across continuations. */
            if (src[i + 1] === '\n') line++;
            i += 2;
            continue;
          }
          if (d === quote) { i++; term = true; break; }
          if (d === '\n' || d === '\r') break; /* unterminated */
          i++;
        }
        if (!term) {
          diagnostics.push({
            severity: 'warn', line: startLine,
            message: 'unterminated ' + (quote === '"' ? 'string' : 'character') + ' literal'
          });
        }
        push(quote === '"' ? 'string' : 'char', src.slice(start, i), startLine);
        atLineStart = false;
        continue;
      }

      /* --- numbers ---
       * C's pp-number grammar: digits, identifier characters (which covers
       * hex digits, `u`, `L`, `f` suffixes and C++14 digit separators), dots,
       * and a sign only when it directly follows an exponent marker, so that
       * `1e-5` is one token but `a-5` is three. */
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
        i++;
        while (i < n) {
          var e = src[i];
          if (isIdentPart(e) || e === '.') { i++; continue; }
          if ((e === '+' || e === '-') && 'eEpP'.indexOf(src[i - 1]) >= 0) { i++; continue; }
          break;
        }
        push('number', src.slice(start, i), startLine);
        atLineStart = false;
        continue;
      }

      /* --- identifiers and keywords --- */
      if (isIdentStart(c)) {
        i++;
        while (i < n && isIdentPart(src[i])) i++;
        var word = src.slice(start, i);
        push(C_KEYWORDS.has(word) ? 'keyword' : 'ident', word, startLine);
        atLineStart = false;
        continue;
      }

      /* --- preprocessor hash --- */
      if (c === '#' && atLineStart) {
        inPP = true;
        i++;
        tokens.push({ k: 'hash', v: '#', i: start, line: startLine, pp: true });
        atLineStart = false;
        continue;
      }

      /* --- punctuators --- */
      var matched = null;
      for (var p = 0; p < PUNCT.length; p++) {
        if (src.startsWith(PUNCT[p], i)) { matched = PUNCT[p]; break; }
      }
      if (matched) {
        i += matched.length;
        push('punct', matched, startLine);
        atLineStart = false;
        continue;
      }

      /* --- anything else: emit one character so coverage stays total --- */
      i++;
      push('punct', src.slice(start, i), startLine);
      atLineStart = false;
    }

    return { tokens: tokens, diagnostics: diagnostics };
  }

  /** Tokens that carry no meaning for the indexer. */
  function isTrivia(t) {
    return t.k === 'ws' || t.k === 'nl' || t.k === 'comment' || t.k === 'cont';
  }

  /* ===================================================================== *
   * 2. Declaration index
   * ===================================================================== *
   *
   * Walks the token stream at brace depth 0 and classifies each top-level
   * construct. This is deliberately a ctags-class heuristic rather than a
   * compiler front end: no macro expansion, no #if evaluation. The honest
   * consequence is documented in the README under Limitations, and every
   * reference that cannot be resolved is reported as unresolved rather than
   * guessed at.
   */

  /* Index of the matching close token, or -1. `open`/`close` are punctuators. */
  function matchDelim(tokens, from, open, close) {
    var depth = 0;
    for (var i = from; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.k !== 'punct') continue;
      if (t.v === open) depth++;
      else if (t.v === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * Find the declarator name in a prefix of significant tokens.
   *
   * Handles the two shapes that actually matter in C:
   *   int   foo(int a)        -> ident directly before a top-level `(`
   *   int (*foo)(int a)       -> ident after `(*`, i.e. a function pointer
   * Returns {name, at} where `at` indexes into `sig`, or null.
   */
  function functionDeclarator(sig) {
    /* Function-pointer declarator: `(` `*`+ ident `)` `(` */
    for (var i = 0; i + 2 < sig.length; i++) {
      if (sig[i].v === '(' && sig[i + 1].v === '*') {
        var j = i + 1;
        while (j < sig.length && sig[j].v === '*') j++;
        if (j < sig.length && sig[j].k === 'ident' &&
            j + 1 < sig.length && sig[j + 1].v === ')') {
          return { name: sig[j].v, at: j, kind: 'fnptr' };
        }
      }
    }
    /* Plain declarator: the LAST ident immediately followed by `(` at paren
     * depth 0. Last, not first, so `struct hdr *parse_hdr(` picks parse_hdr. */
    var depth = 0, best = null;
    for (var k = 0; k < sig.length; k++) {
      var t = sig[k];
      if (t.k === 'punct') {
        if (t.v === '(') {
          if (depth === 0 && k > 0 && sig[k - 1].k === 'ident') {
            best = { name: sig[k - 1].v, at: k - 1, kind: 'plain' };
          }
          depth++;
        } else if (t.v === ')') depth--;
      }
    }
    return best;
  }

  /** Last identifier at paren/bracket depth 0 -- the name of a plain object. */
  function objectDeclaratorNames(sig) {
    var names = [];
    var depth = 0;
    var pending = null;
    for (var i = 0; i < sig.length; i++) {
      var t = sig[i];
      if (t.k === 'punct') {
        if (t.v === '(' || t.v === '[' || t.v === '{') { depth++; continue; }
        if (t.v === ')' || t.v === ']' || t.v === '}') { depth--; continue; }
        if (depth === 0 && t.v === ',') {
          if (pending) { names.push(pending); pending = null; }
          continue;
        }
        continue;
      }
      if (depth === 0 && t.k === 'ident') pending = t.v;
      /* A `{` at depth 0 of an initializer is handled by the caller. */
    }
    if (pending) names.push(pending);
    /* The first ident of `struct foo bar` is a type reference, not a name;
     * objectDeclaratorNames only keeps the last ident of each comma clause,
     * so that case already resolves correctly. */
    return names;
  }

  function sliceText(src, tokens, a, b) {
    if (a < 0 || b < 0 || a >= tokens.length) return '';
    var startOff = tokens[a].i;
    var endTok = tokens[Math.min(b, tokens.length - 1)];
    return src.slice(startOff, endTok.i + endTok.v.length);
  }

  /**
   * Index one translation unit.
   * @param {string} path
   * @param {string} src
   * @returns {object} file record with symbols, includes, diagnostics
   */
  function indexFile(path, src) {
    var lex = tokenize(src);
    var tokens = lex.tokens;
    var diagnostics = lex.diagnostics.map(function (d) {
      return { severity: d.severity, file: path, line: d.line, message: d.message };
    });

    /* Significant tokens plus a map back to the full stream, so symbol spans
     * can be expressed in full-stream indices (needed for rendering). */
    var sig = [];
    var sigToFull = [];
    for (var i = 0; i < tokens.length; i++) {
      if (!isTrivia(tokens[i])) { sig.push(tokens[i]); sigToFull.push(i); }
    }

    var symbols = [];
    var includes = [];

    /* Leading comment block immediately above a symbol, used as its doc. */
    function docFor(fullIdx) {
      var out = [];
      var j = fullIdx - 1;
      var sawNl = 0;
      while (j >= 0) {
        var t = tokens[j];
        if (t.k === 'ws' || t.k === 'cont') { j--; continue; }
        if (t.k === 'nl') {
          /* Two newlines in a row is a blank line, which separates a comment
           * from the declaration below it. Consecutive comment lines are only
           * ever one newline apart, so this does not split a doc block. */
          if (++sawNl >= 2) break;
          j--;
          continue;
        }
        if (t.k === 'comment') { out.unshift(t.v); sawNl = 0; j--; continue; }
        break;
      }
      return out.join('\n');
    }

    var p = 0;
    while (p < sig.length) {
      var t = sig[p];

      /* ---------------- preprocessor directives ---------------- */
      if (t.k === 'hash') {
        var dir = sig[p + 1];
        var lineNo = t.line;
        var dirEnd = endOfDirective(sig, p);
        if (dir && (dir.k === 'ident' || dir.k === 'keyword')) {
          if (dir.v === 'define' && p + 2 < dirEnd) {
            var nameTok = sig[p + 2];
            /* function-like iff `(` is glued to the name with no space */
            var after = p + 3 < dirEnd ? sig[p + 3] : null;
            var funcLike = !!(after && after.v === '(' &&
              after.i === nameTok.i + nameTok.v.length);
            var lastP = dirEnd - 1;
            symbols.push({
              kind: 'macro', name: nameTok.v, file: path, line: lineNo,
              static: false, funcLike: funcLike,
              signature: sliceText(src, tokens, sigToFull[p], sigToFull[lastP])
                .split('\n')[0].trim(),
              start: sigToFull[p], end: sigToFull[lastP],
              bodyStart: -1, bodyEnd: -1, doc: docFor(sigToFull[p])
            });
          } else if (dir.v === 'include') {
            var parts = [];
            for (var q = p + 2; q < dirEnd; q++) parts.push(sig[q].v);
            var raw = parts.join('');
            var m = /^<(.+)>$/.exec(raw) || /^"(.+)"$/.exec(raw);
            includes.push({
              target: m ? m[1] : raw,
              system: raw.charAt(0) === '<',
              line: lineNo
            });
          }
        }
        p = dirEnd;
        continue;
      }

      /* ---------------- top-level declaration ---------------- */
      var declStart = p;
      var prefix = [];
      var stop = null;
      var parenDepth = 0;
      var q2 = p;
      while (q2 < sig.length) {
        var u = sig[q2];
        if (u.k === 'hash') {
          /* A directive inside a declaration (common with #ifdef); skip it. */
          q2 = endOfDirective(sig, q2);
          continue;
        }
        if (u.k === 'punct') {
          /* A closing brace with nothing before it is the tail of a block we
           * stepped into (`extern "C" { ... }`) or the fallout of an unbalanced
           * #if. Drop it and start the declaration afresh, rather than letting
           * it absorb whatever is declared next. */
          if (u.v === '}' && parenDepth <= 0 && prefix.length === 0) {
            q2++;
            declStart = q2;
            continue;
          }
          if (u.v === '(' || u.v === '[') parenDepth++;
          else if (u.v === ')' || u.v === ']') parenDepth--;
          else if (parenDepth <= 0 && (u.v === ';' || u.v === '{' || u.v === '=')) {
            stop = u.v;
            break;
          }
        }
        prefix.push(u);
        q2++;
      }
      if (stop === null) break; /* ran off the end */
      if (prefix.length === 0) { p = q2 + 1; continue; } /* `;` or `{}` alone */

      var hasTypedef = prefix.some(function (x) { return x.v === 'typedef'; });
      var isStatic = prefix.some(function (x) { return x.v === 'static'; });
      var tagIdx = -1;
      for (var r = 0; r < prefix.length; r++) {
        if (prefix[r].v === 'struct' || prefix[r].v === 'union' || prefix[r].v === 'enum') {
          tagIdx = r;
          break;
        }
      }

      if (stop === '{') {
        var openFull = sigToFull[q2];
        var closeSig = matchDelimSig(sig, q2, '{', '}');
        var closeFull = closeSig >= 0 ? sigToFull[closeSig] : tokens.length - 1;

        /* A tagged aggregate body: `struct NAME {` or `enum {` with the brace
         * immediately after the tag (allowing an optional name). */
        var isAggregate = false;
        if (tagIdx >= 0) {
          var afterTag = prefix[tagIdx + 1];
          if (!afterTag) isAggregate = true;
          else if (afterTag.k === 'ident' && tagIdx + 2 === prefix.length) isAggregate = true;
          else if (tagIdx + 1 === prefix.length) isAggregate = true;
        }

        var declarator = functionDeclarator(prefix);
        /* A function definition needs a declarator AND must not be an
         * aggregate body, AND the token right before `{` must be `)`. */
        var prevSig = prefix.length ? prefix[prefix.length - 1] : null;
        var looksLikeFunction = !!declarator && !isAggregate && !hasTypedef &&
          prevSig && prevSig.v === ')';

        if (isAggregate) {
          var tagKind = prefix[tagIdx].v;
          var tagName = (prefix[tagIdx + 1] && prefix[tagIdx + 1].k === 'ident')
            ? prefix[tagIdx + 1].v : null;
          /* `typedef struct {...} Name;` -- the useful name is after `}`. */
          var trailing = [];
          var r2 = closeSig + 1;
          while (r2 < sig.length && !(sig[r2].k === 'punct' && sig[r2].v === ';')) {
            trailing.push(sig[r2]); r2++;
          }
          var aliasNames = objectDeclaratorNames(trailing);
          var displayName = tagName || aliasNames[aliasNames.length - 1] || '(anonymous)';
          symbols.push({
            kind: tagKind, name: displayName, tag: tagName, file: path,
            line: prefix[tagIdx].line, static: isStatic,
            aliases: hasTypedef ? aliasNames : [],
            signature: tagKind + (tagName ? ' ' + tagName : ''),
            start: sigToFull[declStart],
            end: r2 < sig.length ? sigToFull[r2] : closeFull,
            bodyStart: openFull, bodyEnd: closeFull, doc: docFor(sigToFull[declStart])
          });
          if (hasTypedef) {
            aliasNames.forEach(function (an) {
              if (an === tagName) return;
              symbols.push({
                kind: 'typedef', name: an, file: path, line: prefix[tagIdx].line,
                static: isStatic, aliasOf: tagKind + (tagName ? ' ' + tagName : ' {...}'),
                signature: 'typedef ' + tagKind + (tagName ? ' ' + tagName : ' {...}') + ' ' + an,
                start: sigToFull[declStart], end: closeFull,
                bodyStart: openFull, bodyEnd: closeFull, doc: ''
              });
            });
          }
          p = (r2 < sig.length ? r2 + 1 : closeSig + 1);
          continue;
        }

        if (looksLikeFunction) {
          symbols.push({
            kind: 'function', name: declarator.name, file: path,
            line: prefix[declarator.at].line, static: isStatic, definition: true,
            signature: normalizeSignature(
              sliceText(src, tokens, sigToFull[declStart], sigToFull[q2 - 1])),
            start: sigToFull[declStart], end: closeFull,
            bodyStart: openFull, bodyEnd: closeFull,
            doc: docFor(sigToFull[declStart])
          });
          p = closeSig >= 0 ? closeSig + 1 : sig.length;
          continue;
        }

        /* Unrecognised brace block at top level (e.g. `extern "C" {`, or an
         * aggregate used inline). Step into it so its contents still get
         * indexed rather than skipped wholesale. */
        p = q2 + 1;
        continue;
      }

      if (stop === '=') {
        /* Initialised object: record the name, then skip the initialiser. */
        var gnames = objectDeclaratorNames(prefix);
        var gname = gnames[gnames.length - 1];
        if (gname) {
          symbols.push({
            kind: 'variable', name: gname, file: path, line: prefix[0].line,
            static: isStatic,
            signature: normalizeSignature(
              sliceText(src, tokens, sigToFull[declStart], sigToFull[q2 - 1])),
            start: sigToFull[declStart], end: sigToFull[q2],
            bodyStart: -1, bodyEnd: -1, doc: docFor(sigToFull[declStart])
          });
        }
        var sk = q2;
        var d2 = 0;
        while (sk < sig.length) {
          var z = sig[sk];
          if (z.k === 'punct') {
            if (z.v === '{' || z.v === '(' || z.v === '[') d2++;
            else if (z.v === '}' || z.v === ')' || z.v === ']') d2--;
            else if (z.v === ';' && d2 <= 0) { sk++; break; }
          }
          sk++;
        }
        /* Extend the recorded span to the terminating semicolon. */
        if (symbols.length && symbols[symbols.length - 1].name === gname) {
          symbols[symbols.length - 1].end = sigToFull[Math.min(sk - 1, sig.length - 1)];
        }
        p = sk;
        continue;
      }

      /* stop === ';' */
      if (hasTypedef) {
        var td = functionDeclarator(prefix);
        var tdNames = td && td.kind === 'fnptr' ? [td.name] : objectDeclaratorNames(prefix);
        /* `typedef struct foo foo;` yields the same ident twice; dedupe. */
        var seen = new Set();
        tdNames.forEach(function (nm) {
          if (!nm || seen.has(nm)) return;
          seen.add(nm);
          symbols.push({
            kind: 'typedef', name: nm, file: path, line: prefix[0].line,
            static: isStatic,
            signature: normalizeSignature(
              sliceText(src, tokens, sigToFull[declStart], sigToFull[q2])),
            start: sigToFull[declStart], end: sigToFull[q2],
            bodyStart: -1, bodyEnd: -1, doc: docFor(sigToFull[declStart])
          });
        });
      } else if (tagIdx >= 0 && tagIdx + 1 < prefix.length &&
                 prefix[tagIdx + 1].k === 'ident' && tagIdx + 2 === prefix.length) {
        /* Forward declaration `struct foo;` -- record nothing; the real
         * definition elsewhere is what readers want. */
      } else {
        var fd = functionDeclarator(prefix);
        var lastTok = prefix[prefix.length - 1];
        var isPrototype = fd && lastTok && lastTok.v === ')' && fd.kind === 'plain';
        if (isPrototype) {
          symbols.push({
            kind: 'function', name: fd.name, file: path,
            line: prefix[fd.at].line, static: isStatic, definition: false,
            signature: normalizeSignature(
              sliceText(src, tokens, sigToFull[declStart], sigToFull[q2])),
            start: sigToFull[declStart], end: sigToFull[q2],
            bodyStart: -1, bodyEnd: -1, doc: docFor(sigToFull[declStart])
          });
        } else if (prefix.length) {
          objectDeclaratorNames(prefix).forEach(function (nm) {
            if (!nm) return;
            symbols.push({
              kind: 'variable', name: nm, file: path, line: prefix[0].line,
              static: isStatic,
              signature: normalizeSignature(
                sliceText(src, tokens, sigToFull[declStart], sigToFull[q2])),
              start: sigToFull[declStart], end: sigToFull[q2],
              bodyStart: -1, bodyEnd: -1, doc: docFor(sigToFull[declStart])
            });
          });
        }
      }
      p = q2 + 1;
    }

    return {
      path: path, src: src, tokens: tokens, sig: sig, sigToFull: sigToFull,
      symbols: symbols, includes: includes, diagnostics: diagnostics,
      lineCount: countLines(src)
    };
  }

  /**
   * Index just past the directive that starts at `hashIdx`.
   *
   * Dropping trivia makes consecutive directives an unbroken run of `pp`
   * tokens -- the newline that separated them is gone -- so a run of
   * `#define`s would otherwise read as one directive. The next directive
   * always opens with its own `hash` token (a `#` is only lexed as `hash` at
   * the start of a logical line, so the `#` and `##` macro operators are
   * ordinary punctuation and do not end anything), which is the boundary.
   */
  function endOfDirective(sig, hashIdx) {
    var i = hashIdx + 1;
    while (i < sig.length && sig[i].pp && sig[i].k !== 'hash') i++;
    return i;
  }

  function matchDelimSig(sig, from, open, close) {
    var depth = 0;
    for (var i = from; i < sig.length; i++) {
      var t = sig[i];
      if (t.k !== 'punct') continue;
      if (t.v === open) depth++;
      else if (t.v === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function normalizeSignature(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function countLines(src) {
    if (src === '') return 0;
    var n = 1;
    for (var i = 0; i < src.length; i++) if (src[i] === '\n') n++;
    return n;
  }

  /* ===================================================================== *
   * 3. Cross-file symbol table and reference resolution
   * ===================================================================== */

  var LINKAGE_LOCAL = 'internal';
  var LINKAGE_GLOBAL = 'external';

  /**
   * Build a whole-project index.
   * @param {Array<{path:string, text:string}>} files
   * @returns {object} project index
   */
  function buildProject(files) {
    var fileRecords = [];
    var diagnostics = [];

    files.forEach(function (f) {
      var rec = indexFile(f.path, f.text);
      fileRecords.push(rec);
      diagnostics = diagnostics.concat(rec.diagnostics);
    });

    /* Assign stable ids and build lookup tables. */
    var symbols = [];
    fileRecords.forEach(function (rec) {
      rec.symbols.forEach(function (s) {
        s.id = symbols.length;
        s.linkage = s.static ? LINKAGE_LOCAL : LINKAGE_GLOBAL;
        symbols.push(s);
      });
    });

    /* name -> symbol ids, split by linkage so `static` shadowing works. */
    var globalByName = new Map();
    var localByFileName = new Map(); /* `file name` -> ids */
    symbols.forEach(function (s) {
      if (s.linkage === LINKAGE_LOCAL) {
        var key = s.file + ' ' + s.name;
        if (!localByFileName.has(key)) localByFileName.set(key, []);
        localByFileName.get(key).push(s.id);
      } else {
        if (!globalByName.has(s.name)) globalByName.set(s.name, []);
        globalByName.get(s.name).push(s.id);
      }
    });

    /* Typedef and macro name sets drive type-use and macro-use detection. */
    var typeNames = new Set();
    var macroNames = new Set();
    symbols.forEach(function (s) {
      if (s.kind === 'typedef') typeNames.add(s.name);
      if (s.kind === 'macro') macroNames.add(s.name);
      if (s.aliases) s.aliases.forEach(function (a) { typeNames.add(a); });
    });

    var project = {
      files: fileRecords, symbols: symbols,
      globalByName: globalByName, localByFileName: localByFileName,
      typeNames: typeNames, macroNames: macroNames,
      diagnostics: diagnostics
    };

    /* Report genuinely ambiguous external definitions -- two non-static
     * definitions of the same function name would not link, and silently
     * picking one would make the reading view lie. */
    globalByName.forEach(function (ids, name) {
      var defs = ids.filter(function (id) {
        return symbols[id].kind === 'function' && symbols[id].definition;
      });
      if (defs.length > 1) {
        diagnostics.push({
          severity: 'warn', file: symbols[defs[0]].file, line: symbols[defs[0]].line,
          message: 'two external definitions of `' + name + '` (' +
            defs.map(function (id) { return symbols[id].file + ':' + symbols[id].line; }).join(', ') +
            '); references to it are reported as ambiguous'
        });
      }
    });

    resolveReferences(project);
    buildGraph(project);
    return project;
  }

  /**
   * Resolve a name as seen from `fromFile`, following C's linkage rules:
   * a file-scope `static` in the same translation unit wins over anything
   * external; a definition wins over a bare prototype.
   */
  function lookup(project, name, fromFile, kinds) {
    function pick(ids) {
      if (!ids || !ids.length) return null;
      var cands = ids.filter(function (id) {
        return !kinds || kinds.indexOf(project.symbols[id].kind) >= 0;
      });
      if (!cands.length) return null;
      var defs = cands.filter(function (id) {
        var s = project.symbols[id];
        return s.kind !== 'function' || s.definition;
      });
      var pool = defs.length ? defs : cands;
      return { ids: pool, ambiguous: pool.length > 1 };
    }
    var local = pick(project.localByFileName.get(fromFile + ' ' + name));
    if (local) return local;
    return pick(project.globalByName.get(name));
  }

  /**
   * Walk every function body and record outbound references.
   * Each reference carries the token index of its name so the UI can place
   * the expansion control exactly on the call site.
   */
  function resolveReferences(project) {
    var unresolved = new Map();

    project.files.forEach(function (rec) {
      /* significant-token index for fast neighbour lookups within a body */
      var fullToSig = new Map();
      rec.sigToFull.forEach(function (fullIdx, sigIdx) { fullToSig.set(fullIdx, sigIdx); });

      rec.symbols.forEach(function (sym) {
        sym.refs = [];
        if (sym.kind !== 'function' || !sym.definition) return;
        if (sym.bodyStart < 0) return;

        /* Scan from the start of the declaration, not the opening brace: the
         * types in the parameter list and return type are exactly the ones a
         * reader wants to look up, and the reading surface renders them. */
        var fromSig = fullToSig.get(sym.start);
        var toSig = fullToSig.get(sym.bodyEnd);
        if (fromSig === undefined || toSig === undefined) return;

        for (var i = fromSig; i <= toSig; i++) {
          var t = rec.sig[i];
          if (t.k !== 'ident' && t.k !== 'keyword') continue;

          var prev = rec.sig[i - 1];
          var next = rec.sig[i + 1];
          var memberAccess = prev && prev.k === 'punct' &&
            (prev.v === '.' || prev.v === '->');

          /* ---- calls: ident immediately followed by `(` ---- */
          if (next && next.k === 'punct' && next.v === '(' && !NOT_CALLABLE.has(t.v)) {
            if (t.k === 'keyword') continue;
            /* The function's own name in its own signature is the declarator,
             * not a recursive call. */
            if (t.v === sym.name && rec.sigToFull[i] < sym.bodyStart) continue;
            if (memberAccess) {
              sym.refs.push({
                name: t.v, relation: 'indirect-call', tokenFull: rec.sigToFull[i],
                line: t.line, targets: [], note: 'call through a struct member (function pointer)'
              });
              continue;
            }
            /* `int (*fp)(void)` inside a body is a declaration, not a call. */
            if (prev && prev.k === 'punct' && prev.v === '*' &&
                rec.sig[i - 2] && rec.sig[i - 2].v === '(') {
              continue;
            }
            addRef(rec, sym, t, i, 'call', ['function', 'macro']);
            continue;
          }

          if (memberAccess) continue;

          /* ---- tag types: `struct X` / `union X` / `enum X` ---- */
          if (t.k === 'keyword' &&
              (t.v === 'struct' || t.v === 'union' || t.v === 'enum')) {
            if (next && next.k === 'ident') {
              addRef(rec, sym, next, i + 1, 'type', [t.v]);
              i++;
            }
            continue;
          }
          if (t.k === 'keyword') continue;

          /* ---- typedef names ---- */
          if (project.typeNames.has(t.v)) {
            addRef(rec, sym, t, i, 'type', ['typedef', 'struct', 'union', 'enum']);
            continue;
          }
          /* ---- object-like macros ---- */
          if (project.macroNames.has(t.v)) {
            addRef(rec, sym, t, i, 'macro', ['macro']);
            continue;
          }
          /* ---- file-scope variables ---- */
          if (lookup(project, t.v, rec.path, ['variable'])) {
            addRef(rec, sym, t, i, 'reads', ['variable']);
          }
        }
      });
    });

    function addRef(rec, sym, tok, sigIdx, relation, kinds) {
      var hit = lookup(project, tok.v, rec.path, kinds);
      var ref = {
        name: tok.v, relation: relation, tokenFull: rec.sigToFull[sigIdx],
        line: tok.line, targets: hit ? hit.ids.slice() : [],
        ambiguous: hit ? hit.ambiguous : false
      };
      if (!hit) {
        ref.note = 'not defined in this project (library function, macro, or ' +
          'hidden behind the preprocessor)';
        var u = unresolved.get(tok.v) || { name: tok.v, count: 0, relation: relation };
        u.count++;
        unresolved.set(tok.v, u);
      }
      /* Every call site is kept in `refs` so the reading view can place an
       * expander on each one; the graph deduplicates edges separately. */
      sym.refs.push(ref);
    }

    project.unresolved = Array.from(unresolved.values())
      .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
  }

  /* ===================================================================== *
   * 4. Dependency graph, strongly connected components, reading order
   * ===================================================================== */

  function buildGraph(project) {
    var n = project.symbols.length;
    var out = [];
    var inn = [];
    for (var i = 0; i < n; i++) { out.push(new Set()); inn.push(new Set()); }

    project.symbols.forEach(function (s) {
      (s.refs || []).forEach(function (r) {
        r.targets.forEach(function (tid) {
          if (tid === s.id) return; /* self-recursion: not a reading-order edge */
          out[s.id].add(tid);
          inn[tid].add(s.id);
        });
      });
    });

    project.out = out.map(function (st) { return Array.from(st); });
    project.in = inn.map(function (st) { return Array.from(st); });

    var scc = tarjan(project.out);
    project.scc = scc.comp;
    project.components = scc.groups;
    project.readingOrder = readingOrder(project);
    return project;
  }

  /**
   * Tarjan's strongly connected components, iterative so that a deeply
   * nested call graph cannot blow the JS stack (the recursive formulation
   * overflows on real kernels at a few thousand frames).
   */
  function tarjan(adj) {
    var n = adj.length;
    var index = new Int32Array(n).fill(-1);
    var low = new Int32Array(n).fill(0);
    var onStack = new Uint8Array(n);
    var comp = new Int32Array(n).fill(-1);
    var stack = [];
    var groups = [];
    var counter = 0;

    for (var root = 0; root < n; root++) {
      if (index[root] !== -1) continue;
      /* frames: [node, next-edge-cursor] */
      var work = [[root, 0]];
      index[root] = low[root] = counter++;
      stack.push(root);
      onStack[root] = 1;

      while (work.length) {
        var frame = work[work.length - 1];
        var v = frame[0];
        if (frame[1] < adj[v].length) {
          var w = adj[v][frame[1]++];
          if (index[w] === -1) {
            index[w] = low[w] = counter++;
            stack.push(w);
            onStack[w] = 1;
            work.push([w, 0]);
          } else if (onStack[w]) {
            if (index[w] < low[v]) low[v] = index[w];
          }
          continue;
        }
        work.pop();
        if (work.length) {
          var parent = work[work.length - 1][0];
          if (low[v] < low[parent]) low[parent] = low[v];
        }
        if (low[v] === index[v]) {
          var group = [];
          for (;;) {
            var x = stack.pop();
            onStack[x] = 0;
            comp[x] = groups.length;
            group.push(x);
            if (x === v) break;
          }
          groups.push(group);
        }
      }
    }
    return { comp: comp, groups: groups };
  }

  /**
   * A define-before-use linearisation of the project.
   *
   * The dependency graph is condensed by SCC (so mutual recursion becomes one
   * node), the condensation is topologically sorted, and each component is
   * emitted with its members in source order. The result is a listing you can
   * read front to back: every name is defined before it is used, EXCEPT on the
   * edges we report explicitly as `backEdges` -- the cycles that make a strict
   * ordering impossible. Those are the places a human reader genuinely has to
   * take something on trust, and naming them is more useful than hiding them.
   */
  function readingOrder(project) {
    var groups = project.components;
    var comp = project.scc;
    var gN = groups.length;

    /* Condensation edges, deduplicated. */
    var gOut = [];
    var indeg = new Int32Array(gN);
    for (var g = 0; g < gN; g++) gOut.push(new Set());
    project.out.forEach(function (targets, v) {
      targets.forEach(function (w) {
        var a = comp[v], b = comp[w];
        if (a === b) return;
        /* v depends on w, so w must come first: edge w -> v. */
        if (!gOut[b].has(a)) { gOut[b].add(a); indeg[a]++; }
      });
    });

    /* Kahn, breaking ties by earliest source position so the output is stable
     * and reads in roughly the order the author wrote things. */
    function groupKey(gi) {
      var best = null;
      groups[gi].forEach(function (id) {
        var s = project.symbols[id];
        var key = s.file + ' ' + String(s.line).padStart(8, '0');
        if (best === null || key < best) best = key;
      });
      return best === null ? '' : best;
    }
    var keys = [];
    for (var gi = 0; gi < gN; gi++) keys.push(groupKey(gi));

    var ready = [];
    for (var gj = 0; gj < gN; gj++) if (indeg[gj] === 0) ready.push(gj);
    ready.sort(function (a, b) { return keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b; });

    var orderGroups = [];
    var remaining = new Int32Array(indeg);
    while (ready.length) {
      var gx = ready.shift();
      orderGroups.push(gx);
      var added = [];
      gOut[gx].forEach(function (gy) {
        if (--remaining[gy] === 0) added.push(gy);
      });
      if (added.length) {
        added.sort(function (a, b) { return keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b; });
        ready = ready.concat(added);
        ready.sort(function (a, b) { return keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b; });
      }
    }
    /* Condensations are acyclic, so Kahn always drains; this guard documents
     * that rather than trusting it silently. */
    if (orderGroups.length !== gN) {
      for (var gz = 0; gz < gN; gz++) {
        if (orderGroups.indexOf(gz) < 0) orderGroups.push(gz);
      }
    }

    var sequence = [];
    var cycles = [];
    orderGroups.forEach(function (gi) {
      var members = groups[gi].slice().sort(function (a, b) {
        var sa = project.symbols[a], sb = project.symbols[b];
        if (sa.file !== sb.file) return sa.file < sb.file ? -1 : 1;
        return sa.line - sb.line;
      });
      if (members.length > 1) cycles.push(members.slice());
      members.forEach(function (id) { sequence.push(id); });
    });

    /* Back edges: references that point at something appearing later. */
    var position = new Map();
    sequence.forEach(function (id, idx) { position.set(id, idx); });
    var backEdges = [];
    project.symbols.forEach(function (s) {
      var from = position.get(s.id);
      if (from === undefined) return;
      (s.refs || []).forEach(function (r) {
        r.targets.forEach(function (tid) {
          if (tid === s.id) return;
          var to = position.get(tid);
          if (to !== undefined && to > from) {
            backEdges.push({ from: s.id, to: tid, name: r.name, relation: r.relation });
          }
        });
      });
    });

    return { sequence: sequence, cycles: cycles, backEdges: backEdges };
  }

  /* ===================================================================== *
   * 5. Reading-surface construction
   * ===================================================================== *
   *
   * The reading view needs, for one symbol: its source text split into runs
   * that are either plain tokens or expandable reference anchors. Producing
   * that here (rather than in the UI) keeps it testable.
   */

  /**
   * @returns {{symbol, runs: Array<{text, kind, ref?}>}}
   * `runs` concatenated reproduces the symbol's source exactly.
   */
  function renderSymbol(project, id) {
    var sym = project.symbols[id];
    if (!sym) return null;
    var rec = fileOf(project, sym.file);
    var from = sym.start;
    var to = sym.end;

    /* tokenFull -> ref, for anchor placement */
    var anchors = new Map();
    (sym.refs || []).forEach(function (r) {
      if (r.tokenFull >= from && r.tokenFull <= to) anchors.set(r.tokenFull, r);
    });

    var runs = [];
    for (var i = from; i <= to && i < rec.tokens.length; i++) {
      var t = rec.tokens[i];
      var ref = anchors.get(i);
      runs.push({
        text: t.v,
        kind: tokenClass(t, project),
        ref: ref || undefined,
        line: t.line
      });
    }
    return { symbol: sym, runs: runs, firstLine: rec.tokens[from] ? rec.tokens[from].line : sym.line };
  }

  function tokenClass(t, project) {
    switch (t.k) {
      case 'comment': return 'comment';
      case 'string': case 'char': return 'string';
      case 'number': return 'number';
      case 'keyword': return 'keyword';
      case 'hash': return 'pp';
      case 'ident':
        if (t.pp) return 'pp';
        if (project && project.macroNames.has(t.v)) return 'macro';
        if (project && project.typeNames.has(t.v)) return 'type';
        return 'ident';
      case 'punct': return t.pp ? 'pp' : 'punct';
      default: return 'plain';
    }
  }

  function fileOf(project, path) {
    for (var i = 0; i < project.files.length; i++) {
      if (project.files[i].path === path) return project.files[i];
    }
    return null;
  }

  /** Symbols that reference `id`, with their call sites. */
  function callersOf(project, id) {
    return (project.in[id] || []).map(function (fromId) {
      var s = project.symbols[fromId];
      var sites = (s.refs || []).filter(function (r) {
        return r.targets.indexOf(id) >= 0;
      }).map(function (r) { return { line: r.line, relation: r.relation }; });
      return { symbol: s, sites: sites };
    }).sort(function (a, b) {
      if (a.symbol.file !== b.symbol.file) return a.symbol.file < b.symbol.file ? -1 : 1;
      return a.symbol.line - b.symbol.line;
    });
  }

  /**
   * Depth-limited call tree rooted at `id`, with cycles cut and labelled
   * rather than silently truncated.
   */
  function callTree(project, id, maxDepth) {
    var limit = maxDepth === undefined ? 4 : maxDepth;
    function build(nodeId, depth, path) {
      var node = { id: nodeId, symbol: project.symbols[nodeId], children: [], cycle: false, truncated: false };
      if (path.has(nodeId)) { node.cycle = true; return node; }
      if (depth >= limit) {
        node.truncated = (project.out[nodeId] || []).length > 0;
        return node;
      }
      var nextPath = new Set(path);
      nextPath.add(nodeId);
      var seen = new Set();
      var sym = project.symbols[nodeId];
      (sym.refs || []).forEach(function (r) {
        if (r.relation !== 'call') return;
        r.targets.forEach(function (tid) {
          if (seen.has(tid)) return;
          seen.add(tid);
          if (project.symbols[tid].kind !== 'function') return;
          node.children.push(build(tid, depth + 1, nextPath));
        });
      });
      return node;
    }
    return build(id, 0, new Set());
  }

  /* ===================================================================== *
   * 6. Search
   * ===================================================================== */

  /**
   * Subsequence fuzzy match with a score that rewards prefix matches,
   * word-boundary hits (after `_`) and short names.
   * @returns {number|null} score, higher is better; null if no match.
   */
  function fuzzyScore(needle, haystack) {
    if (!needle) return 0;
    var nq = needle.toLowerCase();
    var hs = haystack.toLowerCase();
    var hi = 0, score = 0, streak = 0, firstHit = -1, prevFound = -2;
    for (var qi = 0; qi < nq.length; qi++) {
      var ch = nq[qi];
      var found = -1;
      while (hi < hs.length) {
        if (hs[hi] === ch) { found = hi; break; }
        hi++;
      }
      if (found < 0) return null;
      if (firstHit < 0) firstHit = found;
      var boundary = found === 0 || haystack[found - 1] === '_' ||
        (haystack[found - 1] >= 'a' && haystack[found - 1] <= 'z' &&
         haystack[found] >= 'A' && haystack[found] <= 'Z');
      score += 10;
      if (boundary) score += 12;
      /* Reward letters that landed adjacent to the previous one, so `prsval`
       * ranks parse_value above a name the same letters are scattered through. */
      streak = found === prevFound + 1 ? streak + 1 : 0;
      score += streak * 6;
      prevFound = found;
      hi = found + 1;
    }
    score -= firstHit * 2;
    score -= Math.max(0, haystack.length - nq.length);
    if (hs === nq) score += 200;
    else if (hs.startsWith(nq)) score += 60;
    return score;
  }

  var KIND_RANK = {
    function: 0, macro: 1, struct: 2, union: 2, enum: 2, typedef: 3, variable: 4
  };

  function searchSymbols(project, query, limit) {
    var cap = limit === undefined ? 60 : limit;
    var out = [];
    project.symbols.forEach(function (s) {
      if (s.kind === 'function' && !s.definition) {
        /* Prefer the definition; only surface a bare prototype if nothing
         * defines that name anywhere in the project. */
        var hit = lookup(project, s.name, s.file, ['function']);
        if (hit && hit.ids.some(function (i) { return project.symbols[i].definition; })) return;
      }
      var sc = fuzzyScore(query, s.name);
      if (sc === null) return;
      out.push({ symbol: s, score: sc - (KIND_RANK[s.kind] || 5) });
    });
    out.sort(function (a, b) {
      return b.score - a.score || a.symbol.name.localeCompare(b.symbol.name);
    });
    return out.slice(0, cap);
  }

  /* ===================================================================== *
   * 7. Project statistics
   * ===================================================================== */

  function stats(project) {
    var s = {
      files: project.files.length,
      lines: project.files.reduce(function (a, f) { return a + f.lineCount; }, 0),
      bytes: project.files.reduce(function (a, f) { return a + f.src.length; }, 0),
      functions: 0, prototypes: 0, structs: 0, unions: 0, enums: 0,
      typedefs: 0, macros: 0, variables: 0,
      edges: 0, unresolved: project.unresolved.length,
      cycles: project.readingOrder.cycles.length,
      backEdges: project.readingOrder.backEdges.length,
      roots: 0, leaves: 0
    };
    project.symbols.forEach(function (sym) {
      switch (sym.kind) {
        case 'function': sym.definition ? s.functions++ : s.prototypes++; break;
        case 'struct': s.structs++; break;
        case 'union': s.unions++; break;
        case 'enum': s.enums++; break;
        case 'typedef': s.typedefs++; break;
        case 'macro': s.macros++; break;
        case 'variable': s.variables++; break;
      }
    });
    project.out.forEach(function (targets, id) {
      s.edges += targets.length;
      var sym = project.symbols[id];
      if (sym.kind !== 'function' || !sym.definition) return;
      var calls = targets.filter(function (t) { return project.symbols[t].kind === 'function'; }).length;
      if (calls > s.maxFanOut) { s.maxFanOut = calls; s.deepest = sym.name; }
      if (calls === 0) s.leaves++;
      if ((project.in[id] || []).length === 0) s.roots++;
    });
    return s;
  }

  /* ===================================================================== *
   * 8. Input helpers
   * ===================================================================== */

  var C_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx|inl|ipp)$/i;
  function isCSource(name) { return C_EXT.test(name); }

  /** Strip a shared leading directory so the tree is not all one chain. */
  function stripCommonPrefix(paths) {
    if (paths.length < 2) {
      return paths.map(function (p) {
        var ix = p.lastIndexOf('/');
        return ix < 0 ? p : p.slice(ix + 1);
      });
    }
    var split = paths.map(function (p) { return p.split('/'); });
    var common = 0;
    for (;;) {
      var seg = split[0][common];
      if (seg === undefined || common >= split[0].length - 1) break;
      var all = split.every(function (parts) {
        return parts.length > common + 1 && parts[common] === seg;
      });
      if (!all) break;
      common++;
    }
    return split.map(function (parts) { return parts.slice(common).join('/'); });
  }

  return {
    /* tokenizer */
    tokenize: tokenize, isTrivia: isTrivia, C_KEYWORDS: C_KEYWORDS,
    /* index */
    indexFile: indexFile, buildProject: buildProject, lookup: lookup,
    /* graph */
    tarjan: tarjan, readingOrder: readingOrder,
    /* views */
    renderSymbol: renderSymbol, callersOf: callersOf, callTree: callTree,
    fileOf: fileOf,
    /* search + stats */
    fuzzyScore: fuzzyScore, searchSymbols: searchSymbols, stats: stats,
    /* input */
    isCSource: isCSource, stripCommonPrefix: stripCommonPrefix,
    normalizeSignature: normalizeSignature, countLines: countLines,
    matchDelim: matchDelim
  };
});
