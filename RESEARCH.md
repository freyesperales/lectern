# Research notes — what made this worth building

Development Experiment 059 of [dev-experiments-365](https://github.com/freyesperales/dev-experiments-365).
Swept on 2026-10-01. These are the raw signals, including the four candidate
ideas that got killed, because the kills are the part that decided the build.

## The demand signal, stated plainly

Someone asked for this tool, in public, in specific terms, and nobody has built
it. Then two independent lines of evidence said the obvious predecessor is dead
and unreplaced.

### 1. A literal request, in the asker's own words

[Ask HN: What developer tool do you wish existed in 2026?](https://news.ycombinator.com/item?id=46345827)

Two separate commenters in that thread describe pieces of the same tool. The
clearest is a request for a

> function call graph: you load some source code files, open a function in
> window A (window A now shows **only this function** with all function calls
> and structs highlighted), allows clicking on functions to see the callee, and
> shows struct definitions in a panel

— explicitly wanted for *reading* a complex codebase (the commenter names the
xv6 kernel), and explicitly wanted as something "like VSCode Peek definition
but free and available on Linux". A second commenter in the same thread asks for
an "explorative hex editor … for reverse engineering", which is the same
underlying complaint one layer down: the tools we have render what you already
understand, and do nothing to help you understand it in the first place.

Note what is being asked for and what is not. Not a diagram. Not a metrics
dashboard. A **reading surface**: the function you are on, plus the things it
calls, visible at the same time.

### 2. The obvious predecessor died five years ago and nothing replaced it

[Sourcetrail](https://en.wikipedia.org/wiki/Sourcetrail) was the free, open
source, cross-platform interactive source explorer for C, C++, Java and Python.
It was discontinued in 2021.

The interesting part is what the "alternatives" listings say now, five years on.
[G2's Sourcetrail competitors page](https://www.g2.com/products/sourcetrail/competitors/alternatives),
[libhunt](https://www.libhunt.com/r/OpenSourceSourceTrail/Sourcetrail) and
[AlternativeTo](https://alternativeto.net/software/sourcetrail/about) between
them offer IntelliJ IDEA, SonarQube, PMD, FindBugs, semgrep, mermaid and
Glamorous Toolkit. Those are an IDE, three static analysers, a diagram DSL and a
Smalltalk research environment. None of them is an interactive source explorer.
There is no direct successor — the category simply emptied out.

### 3. What people actually do instead, and why it is unsatisfying

Searching for how developers navigate large unfamiliar C codebases turns up the
same stack every time: `grep`/`git grep`, `ctags`, `cscope`, LXR for the kernel,
`gdb`, and "mostly manual reading"
([1](https://dev.to/aswinmprabhu/getting-started-with-a-new-codebase-2n3e),
[2](https://dev.to/planeta/understanding-a-new-codebase-quickly-53bm),
[3](https://en.wikiversity.org/wiki/Linux/Reading_the_Linux_Kernel_Sources)).
The one tool repeatedly singled out as *good* at this specifically —
Source Insight — is described as "sort of a supercharged ctags", and it is paid
and Windows-only.

Every one of these is a **jump**. You are reading `parse_array`, you need to know
what `match` does, you jump, you read four lines, and now you have to find your
way back to where you were and rebuild the context you just lost. The cost is not
the lookup. The cost is the loss of place, paid once per lookup, hundreds of
times per afternoon.

## What already exists, and why it does not close this

This matters because four other candidate ideas died on exactly this question.

| Tool | What it does | Why it is not this |
| --- | --- | --- |
| [CGraph](https://github.com/brendan-w/cgraph) | Pulls a GitHub repo, draws a force-directed graph of C functions with a code panel | A node-link diagram. Good for topology, useless for reading — you still read one function at a time in the side panel |
| Logic X-Ray | Client-side AST parsing of C/C++/JS/Python into interactive flowcharts | Flowcharts of control flow inside one function, not a reading surface across functions |
| [CodeFlow-Explorer](https://github.com/Baharul0111/CodeFlow-Explorer) | Exports a single-file page with call graph visualisation | Again a graph view; no inline expansion |
| [rtl2dot](https://github.com/cbdevnet/rtl2dot) / egypt | Call graphs from GCC RTL dumps via GraphViz | Needs a working build of the project, emits a static image |
| Doxygen call graphs | Call/caller graphs per function | Needs a configured build, GraphViz, and a generation step; output is a picture |
| ctags / cscope / LSP in an editor | Jump to definition, find references | The jump *is* the problem — it destroys your place |
| VS Code "Peek Definition" | Shows a definition in a modal inset | Modal and single-level: you cannot peek inside a peek, and it closes when you move on. This is the thing the HN commenter asked to be replaced |
| Sourcetrail | Was the real answer | Discontinued 2021 |

The gap is narrow and specific, which is why it is still open: everyone built the
*diagram* (easy to demo, impressive in a screenshot, not actually how reading
works) and nobody built the *recursive inline expansion* (unglamorous, and it
only pays off once you are ten minutes into a real file).

## Signals from the wider sweep

Collected across lanes to keep the pick honest, not just to confirm it.

- **GitHub trending, September–October 2026** — dominated by AI-agent tooling:
  [Paperclip](https://github.com/marc-ko/daily-trending-repo/issues/566) (agent
  dashboard), CLI-Anything, Alibaba's open-code-review, ECC, and `jevgrep`
  ("find code by asking what it does"). *Why it matters:* the energy is all in
  making code legible to **agents**. Nobody is spending it on making code
  legible to **people**, which is where the unmet ask sits.
- **[Ask HN: What do you still do manually in 2026?](https://news.ycombinator.com/item?id=48045237)**
  — "I still manually synthesize information from multiple sources (docs, blog
  posts and threads)"; "Drawing SVGs sits at the worst of both worlds" between
  image and code generation. *Why it matters:* corroborates that synthesis and
  comprehension work, not generation, is where the residual manual pain is.
- **[Ask HN: tools you have made for yourself since AI](https://news.ycombinator.com/item?id=48449187)**
  — a long list of self-built readers and indexers (Hister, Ringbinder,
  Beachcomber, Moniker). *Why it matters:* people keep hand-rolling personal
  comprehension tools, which is what an unserved category looks like from the
  inside. The same thread records "LLM suck at 3d reasoning" and a 10-minute
  transcription ceiling as separate open gaps.
- **The single-file HTML tool wave** —
  [200 tools as single HTML files](https://dev.to/salmanahsan/i-shipped-200-tools-as-single-html-files-heres-what-that-constraint-actually-buys-you-45pi),
  [36 offline security tools in one file](https://dev.to/darkenamber/i-built-36-offline-itsecurity-tools-in-a-single-html-file-no-npm-no-backend-no-tracking-1fn0),
  [hundred-projects](https://github.com/RahimMahat/hundred-projects),
  [One-File-Tools](https://github.com/praveenscience/One-File-Tools).
  *Why it matters:* two things. The form factor is proven and people trust it.
  And the easy ideas in it are taken — so the opening is for something whose
  core is hard enough that a weekend single-file tool cannot reach it.
- **Compiler Explorer** ([repo](https://github.com/compiler-explorer/compiler-explorer))
  — *why it matters:* the proof that a browser page can be the canonical tool
  for a serious systems-programming task, if it is good enough at one thing.

## Four candidates that died, and what killed each

Recorded because "pick a better idea" only means something if you can see the
worse ones being rejected.

1. **In-browser PDF redaction that actually removes the text.** Demand was the
   strongest of anything found — one survey of 72 published "redacted" PDFs
   found 17% still leaked recoverable text, 31% of the US federal ones
   ([dev.to writeup](https://dev.to/giscarunir/a-black-rectangle-is-not-pdf-redaction-a-reproducible-test-1jkf)),
   and Stirling PDF's own
   [issue #7564](https://github.com/Stirling-Tools/Stirling-PDF/issues/7564)
   confirms the failure mode in a popular tool.
   **Killed by saturation:** [Offline-PDF-Redactor](https://github.com/vbookshelf/Offline-PDF-Redactor)
   (local, rasterising, already exactly the safe design), [pdkef](https://github.com/shlomsh/pdkef),
   OpenRedact and Quire all already do offline in-browser redaction.
2. **Photosensitive-seizure (WCAG 2.3.1) flash analysis for video.** PEAT is
   [retired](https://github.com/w3c/wcag/discussions/2562), which looked like an
   open category. **Killed by saturation:** [video-audit.com](https://video-audit.com/)
   is already a free browser tool doing luminance, red-flash and spatial
   analysis with no upload, plus EA's open-source IRIS and FlashDetect.
3. **Cut-list / panel nesting optimiser** (seeded by "computing materials and
   pieces from furniture measurements" in the manual-tasks thread).
   **Killed by saturation:** OpenCutList, CutListCalc, Cutlist Evolution,
   CutOptim, Cut Micro — several already free and browser-based.
4. **Offline viewer for your own GDPR / Google Takeout data export.**
   **Killed by saturation:** TakeoutReader, 4n6 Takeout Viewer,
   [google-takeout-viewer](https://github.com/yesabhishek/google-takeout-viewer),
   Backstory, Data Reclaim. Also unverifiable: building it without real export
   archives to test against would have meant guessing at schemas.

The pattern across all four is worth writing down: in 2026 the *generic*
privacy-first browser utility is a solved and crowded space. What is left open
is the tool whose core is an actual algorithm.

## Why the form factor is a browser page

Not for novelty. Three reasons specific to this problem:

1. **The asker's complaint was setup cost** — "free and available on Linux".
   Reading an unfamiliar C project is often *harder to set up* than to read:
   `compile_commands.json`, the right clangd, the right headers. A page you open
   needs none of it.
2. **You read code you do not trust.** Evaluating a dependency, reviewing a
   patch, auditing a vendored blob. Pasting that into a hosted service is not an
   option, and a local-only page removes the question.
3. **It is the only form where "try it" costs nothing**, which matters for a
   tool whose value only becomes obvious once you are actually reading.

## What the series has not done before

Checked against all 58 prior entries. Experiments 001–044 audit the MCP/agent
ecosystem; 045–058 move through CI, spreadsheets, i18n, e-invoicing, energy,
accessibility, transit, regulatory deadlines, cartonisation, binary formats,
subtitles, tz databases and spaced repetition. Every one of the last ten is the
same shape: an offline pure-stdlib **Python CLI** that reads an artefact and
emits findings with CI exit codes.

lectern is the series' first **browser application**, its first **JavaScript**
deliverable, its first tool with a **designed interface** rather than a text
report, and its first whose subject is a **person's comprehension** rather than
an artefact's correctness. It emits no findings and has no exit codes, because
nothing here is wrong — the reader is just new.
