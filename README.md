# lectern

**Read an unfamiliar C codebase in your browser. Click any function call to set its definition into the text, as deep as you like, without ever losing your place.**

No install, no build, no server, no account. Open `index.html`. Your code never
leaves the tab — there is nowhere for it to go.

---

## The thing it does

You are reading `parse_array`. You need to know what `match` does. Every tool you
have makes you **jump** — and jumping costs you your place, every time, a few
hundred times an afternoon.

lectern doesn't jump. It opens the callee *where you are reading*, inset into the
text like a gloss in the margin of a manuscript, and you keep going:

```
 json.c · parse_array                                      line 300
 ────────────────────────────────────────────────────────────────────
 300  static JsonValue *parse_array(JsonParser *p)
 301  {
 302      if (!match(p, '[')) {¶
      ┃ static int match(JsonParser *p, char c)      json.c:57  close
      ┃  57  static int match(JsonParser *p, char c)
      ┃  58  {
      ┃  59      if (peek(p) != c) {¶
      ┃       ┃ static char peek(const JsonParser *p)   json.c:30
      ┃       ┃  30  static char peek(const JsonParser *p)
      ┃       ┃  31  {
      ┃       ┃  32      return at_end(p) ? '\0' : p->text[p->pos];¶
      ┃       ┃       ┃ static int at_end(const JsonParser *p)  json.c:25
      ┃       ┃       ┃  25  static int at_end(const JsonParser *p)
      ┃       ┃       ┃  26  {
      ┃       ┃       ┃  27      return p->pos >= p->len;
      ┃       ┃       ┃  28  }
      ┃       ┃  33  }
      ┃  60          return 0;
      ┃  61      }
      ┃  62      advance(p);
      ┃  63      return 1;
      ┃  64  }
 303          fail(p, "expected '['");
 304          return NULL;
 305      }
 306      JsonValue *v = new_value(p, JSON_ARRAY);
```

Four levels deep, one scroll position, nothing lost. `¶` marks an open gloss;
every underlined name is one click from being readable. Hovering a `struct` or
`typedef` name puts its definition in the margin instead.

*(That is a transcription of the real interface, reading the demo codebase this
repo ships. Line numbers are the actual ones in `demo/json.c`.)*

## Run it

```sh
git clone https://github.com/freyesperales/lectern
cd lectern
open index.html          # or xdg-open / start, or just double-click it
```

That is the whole install. It opens already reading a bundled 800-line C program
with one call expanded, so you can see what it does before deciding whether you
care.

To read **your** code: click **Open a folder of C source**, or drag a folder onto
the window. It is indexed in the tab. Nothing is uploaded, and there is no server
to upload it to.

<details>
<summary>If the page opens blank</summary>

A few browsers (Safari, and some locked-down corporate policies) refuse to load
sibling scripts over `file://`. Serve it locally instead — still no dependencies:

```sh
node tools/serve.js      # then open http://127.0.0.1:8173/
```
</details>

## Why it exists

[Sourcetrail](https://en.wikipedia.org/wiki/Sourcetrail) — the free, open,
cross-platform interactive source explorer — was discontinued in 2021. Five years
later the "alternatives" lists for it offer IDEs, SonarQube, PMD and a diagram
DSL. None of those is a source explorer. The category emptied out and nobody
refilled it.

Meanwhile, on [Ask HN: What developer tool do you wish existed in 2026?](https://news.ycombinator.com/item?id=46345827),
someone asked for precisely this, in these words:

> function call graph: you load some source code files, open a function in
> window A (window A now shows **only this function** with all function calls and
> structs highlighted), allows clicking on functions to see the callee, and shows
> struct definitions in a panel

— wanted for reading the xv6 kernel, and wanted as something "like VSCode Peek
definition but free and available on Linux".

What exists instead is a shelf of **call-graph diagram** tools (CGraph, Logic
X-Ray, CodeFlow-Explorer, Doxygen, egypt). Diagrams are easy to demo and show
topology, but you cannot read a diagram. The unglamorous half — recursive inline
expansion — is the half nobody built. Full notes and the four other candidate
ideas that got rejected are in [RESEARCH.md](RESEARCH.md).

## What you get

**Read** — the function as its own page, every reference expandable in place,
nested as deep as you like. *Open every call here* unfolds one level at once.
Function pointers and library calls are marked as what they are rather than
guessed at.

**Called by** — who reaches this, and from which line. The question you ask
before changing anything.

**Call tree** — what this function reaches, six levels down, with recursion and
truncation labelled rather than silently cut.

**Reading order** — the one that is genuinely novel. Source files are ordered for
the compiler. This is the same code sorted so **nothing is used before it is
defined**: types and macros first, then what builds on them. Mutual recursion
makes a strict order impossible, so those groups are condensed, listed together,
and every reference that still points forward is counted and shown. It is a
reading list for a codebase you have never seen.

**Index** — what was parsed, and honestly what was not: every unresolved name,
with counts, and every place the source did not lex cleanly.

Plus: fuzzy symbol search (`/`), syntax highlighting driven by the same tokenizer
that built the index, keyboard navigation, light and dark, and a layout that
survives a phone.

## How it works

Four stages, all in `core.js`, all pure functions with no DOM:

```
 source text
     │  tokenize()       full-coverage lexer; every byte lands in one token,
     ▼                   so joining them reproduces the file exactly
 token stream
     │  indexFile()      walks brace depth 0, classifying each construct:
     ▼                   functions, aggregates, typedefs, macros, globals
 declarations
     │  buildProject()   name resolution under C's linkage rules —
     ▼                   file-static shadows external, definition beats prototype
 reference graph
     │  tarjan() → readingOrder()
     ▼                   SCC condensation, then a topological sort
 reading order + back edges
```

Because the highlighter and the indexer read the *same* token stream, what you
see coloured is literally what was indexed. There is no second, divergent regex
highlighter to drift out of sync.

**The design choice worth naming.** Two ways to resolve C:

- *Run a real front end.* Clang via WebAssembly: exact types, correct macro
  expansion, real overload resolution. Costs a 20 MB download, needs
  `compile_commands.json` and every system header, and fails on the code you most
  want to read — the project that doesn't configure on your machine.
- *Index names, like ctags.* Approximate: no macro expansion, both arms of an
  `#ifdef` indexed, function pointers unresolvable.

lectern takes the second, for the reason ctags outlived most of its competitors:
for *reading*, name-level resolution is almost always right, and when it is wrong
the failure is visible and local rather than silent. The discipline that makes it
honest is that nothing is ever guessed. A name that cannot be placed is drawn
greyed out, says why on hover, and is counted in the Index tab. A call through a
struct member is drawn dashed and says so. Two external definitions of one name
produce a diagnostic and the gloss admits which one it picked.

## Limitations

Stated plainly, because a reading tool that overstates its accuracy is worse than
one you know to double-check.

- **No preprocessor.** Macros are indexed but never expanded. Both arms of an
  `#ifdef` are indexed, so a platform-specific project shows you more than any
  single build would.
- **Name resolution, not type resolution.** Calls through function pointers and
  struct members cannot be resolved — they are marked, not guessed. This is the
  main thing a compiler-backed tool would do better.
- **C first.** C++ files lex and index, and the common cases work, but classes,
  namespaces, templates and overloads are not modelled. If you need C++, you need
  something else.
- **No K&R parameter declarations.** Pre-C89 definitions are indexed as
  prototypes, not definitions.
- **Practical ceiling around a few hundred thousand lines.** Indexing is
  synchronous; a large tree holds the thread for a second or two behind a
  progress overlay. The Linux kernel as a whole is out of scope; a subsystem is
  fine.
- **Reading state is not persisted.** Reload and your expansions are gone. There
  is no storage and no URL state yet.
- **Output is for reading, not for CI.** No exit codes, no report format. Nothing
  here is a finding.

## Tests

128 tests, `node --test`, no dependencies:

```sh
node --test test/            # or: make test
```

They cover the lexer against a round-trip property (joining every token must
reproduce the input byte for byte, across unterminated comments, escaped quotes,
line continuations and pp-numbers), the indexer against each declaration shape,
resolution against C's linkage rules including static shadowing across files,
Tarjan against hand-checked graphs plus 60 000-node chains and cycles to prove
the iterative formulation does not blow the stack, and the
**define-before-use property**: for every edge in the dependency graph, either
the target is read earlier or the edge is reported as a back edge — never
neither.

`test/demo.test.js` runs all of it end to end over the bundled C program and
asserts named facts a regression would break: that `parse_value`, `parse_array`
and `parse_object` are found as one mutually recursive component; that
`print_value`'s self-recursion is *not* reported as a cycle; that `arena_alloc`
resolves into `arena.c` from both translation units; that `malloc` and `memcpy`
are reported unresolved while nothing defined in the project ever is.

The demo codebase is a working program, not a fixture dressed up as one:

```sh
make demo      # compiles demo/*.c with -Wall -Wextra and round-trips JSON
```

## Repository

```
index.html        the app: markup and all styling
app.js            UI — turns an index into DOM, handles input
core.js           the engine: tokenizer, indexer, resolver, graph. No DOM.
demo-data.js      generated: demo/ embedded, so file:// needs no fetch
demo/             a real 800-line C program (arena allocator + JSON parser)
test/             128 tests, node --test
tools/            demo bundler, optional static server
```

---

Development Experiment 058 of
[dev-experiments-365](https://github.com/freyesperales/dev-experiments-365) —
one small, useful, finished thing a day. MIT licensed.
