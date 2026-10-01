/*
 * lectern/app.js -- the reading surface.
 *
 * All indexing logic lives in core.js; this file only turns a project index
 * into DOM and handles input. Classic script, no modules, so that opening
 * index.html straight off the filesystem works.
 */
(function () {
  'use strict';

  var L = globalThis.Lectern;

  /* Expanding past this depth almost always means the reader has followed a
   * recursive chain by accident, so we stop and say so. */
  var MAX_GLOSS_DEPTH = 12;

  var state = {
    project: null,
    projectName: '',
    currentId: null,
    view: 'read',
    history: [],
    expandedFiles: new Set(),
    searchIndex: -1,
    searchHits: []
  };

  var el = {};
  var anchorSeq = 0;

  function $(id) { return document.getElementById(id); }

  function init() {
    el.tagline = $('tagline');
    el.search = $('search');
    el.results = $('results');
    el.filelist = $('filelist');
    el.contentsHead = $('contents-head');
    el.callers = $('callers');
    el.views = {
      read: $('view-read'), tree: $('view-tree'),
      order: $('view-order'), health: $('view-health')
    };
    el.marginal = $('marginal');
    el.scrim = $('scrim');
    el.dropzone = $('dropzone');
    el.toast = $('toast');

    wireTabs();
    wireSearch();
    wireFileInputs();
    wireDragDrop();
    wireKeyboard();

    var demo = globalThis.LECTERN_DEMO;
    if (!demo) {
      failHard('demo-data.js did not load. Open index.html from the folder it ' +
        'was cloned into, with core.js, app.js and demo-data.js beside it.');
      return;
    }
    loadFiles(demo.files, demo.name, true);
  }

  function failHard(message) {
    el.views.read.textContent = '';
    var p = document.createElement('p');
    p.className = 'prose';
    p.textContent = message;
    el.views.read.appendChild(p);
  }

  /* ===================================================================== *
   * Loading
   * ===================================================================== */

  function loadFiles(files, name, isDemo) {
    if (!files.length) {
      toast('No C or C++ sources in that selection. lectern reads .c .h .cc ' +
        '.cpp .cxx .hpp .hh .hxx .inl .ipp files.');
      return;
    }

    var bytes = files.reduce(function (a, f) { return a + f.text.length; }, 0);
    el.scrim.hidden = false;
    el.scrim.textContent = 'Reading ' + files.length + ' file' +
      (files.length === 1 ? '' : 's') + ' (' + humanBytes(bytes) + ')…';

    /* Yield once so the scrim actually paints before the synchronous index
     * run, which on a large tree can hold the thread for a second or two. */
    setTimeout(function () {
      var started = Date.now();
      var project;
      try {
        project = L.buildProject(files);
      } catch (err) {
        el.scrim.hidden = true;
        toast('Indexing failed: ' + (err && err.message ? err.message : String(err)));
        return;
      }
      var elapsed = Date.now() - started;

      state.project = project;
      state.projectName = name;
      state.history = [];
      state.expandedFiles = new Set();
      el.scrim.hidden = true;

      var entry = chooseEntrySymbol(project);
      renderRail();
      renderHealth();
      renderOrder();
      if (entry !== null) {
        show(entry, { pushHistory: false, autoExpand: isDemo ? 1 : 0 });
      } else {
        el.views.read.textContent = '';
        var p = document.createElement('p');
        p.className = 'prose';
        p.textContent = 'No function definitions found in those files. ' +
          'The Index tab lists what was parsed.';
        el.views.read.appendChild(p);
      }

      var s = L.stats(project);
      setTagline(name, s);
      if (!isDemo) {
        toast('Read ' + s.files + ' files, ' + fmt(s.lines) + ' lines, ' +
          fmt(s.functions) + ' functions in ' + elapsed + ' ms.');
      }
    }, 0);
  }

  /* The best place to start reading is a public entry point: prefer `main`,
   * then an exported function nothing else in the project calls, then the
   * function with the most callees. */
  function chooseEntrySymbol(project) {
    var defs = project.symbols.filter(function (s) {
      return s.kind === 'function' && s.definition;
    });
    if (!defs.length) return null;

    var main = defs.find(function (s) { return s.name === 'main'; });
    if (main) return main.id;

    var publicRoots = defs.filter(function (s) {
      return !s.static && (project.in[s.id] || []).length === 0;
    });
    var pool = publicRoots.length ? publicRoots : defs;
    pool = pool.slice().sort(function (a, b) {
      return (project.out[b.id] || []).length - (project.out[a.id] || []).length;
    });
    return pool[0].id;
  }

  function setTagline(name, s) {
    el.tagline.textContent = '';
    var strong = document.createElement('strong');
    strong.textContent = name;
    el.tagline.appendChild(document.createTextNode('Reading '));
    el.tagline.appendChild(strong);
    el.tagline.appendChild(document.createTextNode(
      ' — ' + fmt(s.lines) + ' lines, ' + fmt(s.functions) + ' functions, ' +
      fmt(s.edges) + ' references. Click any underlined name to set its ' +
      'definition into the text.'));
  }

  function wireFileInputs() {
    $('pick-folder').addEventListener('click', function () { $('file-folder').click(); });
    $('pick-files').addEventListener('click', function () { $('file-plain').click(); });
    $('file-folder').addEventListener('change', function (ev) {
      intakeFileList(ev.target.files);
      ev.target.value = '';
    });
    $('file-plain').addEventListener('change', function (ev) {
      intakeFileList(ev.target.files);
      ev.target.value = '';
    });
  }

  function intakeFileList(fileList) {
    var wanted = Array.prototype.slice.call(fileList).filter(function (f) {
      var rel = f.webkitRelativePath || f.name;
      if (!L.isCSource(rel)) return false;
      /* Skip the usual vendored/build noise so a real checkout stays readable. */
      return !/(^|\/)(node_modules|\.git|build|out|dist|third_party|vendor|cmake-build[^/]*)\//i.test(rel);
    });
    if (!wanted.length) {
      toast('No C or C++ sources found in that selection.');
      return;
    }
    readAll(wanted);
  }

  function readAll(fileObjs) {
    el.scrim.hidden = false;
    el.scrim.textContent = 'Opening ' + fileObjs.length + ' files…';
    var out = [];
    var pending = fileObjs.length;
    var failed = 0;

    fileObjs.forEach(function (f) {
      var reader = new FileReader();
      reader.onload = function () {
        out.push({ path: f.webkitRelativePath || f.name, text: String(reader.result) });
        done();
      };
      reader.onerror = function () { failed++; done(); };
      reader.readAsText(f);
    });

    function done() {
      if (--pending > 0) return;
      el.scrim.hidden = true;
      if (!out.length) {
        toast('Could not read any of those files.');
        return;
      }
      if (failed) toast(failed + ' file(s) could not be read and were skipped.');
      out.sort(function (a, b) { return a.path.localeCompare(b.path); });
      var short = L.stripCommonPrefix(out.map(function (f) { return f.path; }));
      var root = commonRootName(out.map(function (f) { return f.path; }));
      out.forEach(function (f, i) { f.path = short[i]; });
      loadFiles(out, root, false);
    }
  }

  function commonRootName(paths) {
    if (!paths.length) return 'your code';
    var first = paths[0].split('/');
    if (first.length > 1) return first[0];
    return 'your code';
  }

  function wireDragDrop() {
    var depth = 0;
    window.addEventListener('dragenter', function (ev) {
      ev.preventDefault();
      depth++;
      el.dropzone.hidden = false;
    });
    window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    window.addEventListener('dragleave', function (ev) {
      ev.preventDefault();
      if (--depth <= 0) { depth = 0; el.dropzone.hidden = true; }
    });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault();
      depth = 0;
      el.dropzone.hidden = true;
      var items = ev.dataTransfer && ev.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) {
        var entries = [];
        for (var i = 0; i < items.length; i++) {
          var e = items[i].webkitGetAsEntry();
          if (e) entries.push(e);
        }
        if (entries.length) { walkEntries(entries); return; }
      }
      if (ev.dataTransfer && ev.dataTransfer.files) intakeFileList(ev.dataTransfer.files);
    });
  }

  /* Recursively walk dropped directory entries. Chrome's readEntries() returns
   * at most 100 entries per call, so each reader is drained in a loop. */
  function walkEntries(entries) {
    el.scrim.hidden = false;
    el.scrim.textContent = 'Looking through the folder…';
    var files = [];
    var pending = 0;
    var finished = false;

    function step(entry) {
      pending++;
      if (entry.isFile) {
        entry.file(function (f) {
          var rel = entry.fullPath ? entry.fullPath.replace(/^\//, '') : f.name;
          if (L.isCSource(rel) &&
              !/(^|\/)(node_modules|\.git|build|out|dist|third_party|vendor)\//i.test(rel)) {
            Object.defineProperty(f, 'webkitRelativePath', { value: rel, configurable: true });
            files.push(f);
          }
          settle();
        }, settle);
        return;
      }
      var reader = entry.createReader();
      (function drain() {
        reader.readEntries(function (batch) {
          if (!batch.length) { settle(); return; }
          batch.forEach(step);
          drain();
        }, settle);
      })();
    }

    function settle() {
      if (--pending > 0 || finished) return;
      finished = true;
      el.scrim.hidden = true;
      if (!files.length) {
        toast('No C or C++ sources in that folder.');
        return;
      }
      readAll(files);
    }

    entries.forEach(step);
  }

  /* ===================================================================== *
   * Left rail
   * ===================================================================== */

  var KIND_GLYPH = {
    function: 'f', macro: '#', struct: '{', union: 'u', enum: 'e',
    typedef: 't', variable: 'v'
  };

  function renderRail() {
    var project = state.project;
    el.filelist.textContent = '';
    el.contentsHead.textContent = 'Contents · ' + project.files.length + ' files';

    project.files.forEach(function (rec) {
      var li = document.createElement('li');

      var listed = rec.symbols.filter(function (s) {
        /* Hide prototypes that are defined elsewhere in the project, and the
         * duplicate typedef rows synthesised for `typedef struct {...} X;`. */
        if (s.kind === 'function' && !s.definition) {
          var hit = L.lookup(project, s.name, s.file, ['function']);
          if (hit && hit.ids.some(function (i) { return project.symbols[i].definition; })) {
            return false;
          }
        }
        return true;
      }).sort(function (a, b) { return a.line - b.line; });

      var btn = document.createElement('button');
      btn.className = 'filebtn';
      btn.setAttribute('aria-expanded', 'false');
      btn.appendChild(spanText('name', rec.path));
      btn.appendChild(spanText('count', String(listed.length)));

      var ul = document.createElement('ul');
      ul.className = 'symlist';
      ul.hidden = true;

      listed.forEach(function (s) {
        var sli = document.createElement('li');
        var sb = document.createElement('button');
        sb.className = 'symbtn';
        sb.dataset.sym = String(s.id);
        sb.appendChild(spanText('glyph', KIND_GLYPH[s.kind] || '·'));
        sb.appendChild(spanText('nm', s.name));
        sb.title = s.signature || s.name;
        sb.addEventListener('click', function () { show(s.id); });
        sli.appendChild(sb);
        ul.appendChild(sli);
      });

      btn.addEventListener('click', function () {
        var open = ul.hidden;
        ul.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) state.expandedFiles.add(rec.path);
        else state.expandedFiles.delete(rec.path);
      });

      li.appendChild(btn);
      li.appendChild(ul);
      el.filelist.appendChild(li);
      li._file = rec.path;
      li._ul = ul;
      li._btn = btn;
    });
  }

  function revealInRail(id) {
    var project = state.project;
    var sym = project.symbols[id];
    Array.prototype.forEach.call(el.filelist.children, function (li) {
      if (li._file === sym.file && li._ul.hidden) {
        li._ul.hidden = false;
        li._btn.setAttribute('aria-expanded', 'true');
      }
    });
    var all = el.filelist.querySelectorAll('.symbtn');
    Array.prototype.forEach.call(all, function (b) {
      if (b.dataset.sym === String(id)) {
        b.setAttribute('aria-current', 'true');
        if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
      } else {
        b.removeAttribute('aria-current');
      }
    });
  }

  function renderCallers(id) {
    var project = state.project;
    el.callers.textContent = '';
    var list = L.callersOf(project, id);
    if (!list.length) {
      var p = document.createElement('p');
      p.className = 'none';
      p.textContent = 'Nothing in this project refers to it. It is either an ' +
        'entry point or dead code.';
      el.callers.appendChild(p);
      return;
    }
    list.forEach(function (c) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.appendChild(spanText('nm', c.symbol.name));
      var lines = c.sites.map(function (s) { return s.line; });
      b.appendChild(spanText('at', shortFile(c.symbol.file) + ':' + lines.join(',')));
      b.title = c.symbol.signature || c.symbol.name;
      b.addEventListener('click', function () { show(c.symbol.id); });
      li.appendChild(b);
      el.callers.appendChild(li);
    });
  }

  /* ===================================================================== *
   * The reading view
   * ===================================================================== */

  function show(id, opts) {
    var o = opts || {};
    if (state.currentId !== null && o.pushHistory !== false && state.currentId !== id) {
      state.history.push(state.currentId);
      if (state.history.length > 200) state.history.shift();
    }
    state.currentId = id;
    selectView('read');
    renderRead(id, o.autoExpand || 0);
    revealInRail(id);
    renderCallers(id);
    renderTree(id);
    el.views.read.scrollTop = 0;
    var main = $('main');
    if (main) main.scrollTop = 0;
  }

  function renderRead(id, autoExpand) {
    var project = state.project;
    var sym = project.symbols[id];
    var host = el.views.read;
    host.textContent = '';

    var leaf = document.createElement('article');
    leaf.className = 'leaf';

    /* ---- head ---- */
    var head = document.createElement('div');
    head.className = 'leafhead';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = sym.name;
    head.appendChild(h2);
    head.appendChild(spanText('kindtag', describeKind(sym)));
    head.appendChild(spanText('where', shortFile(sym.file) + ':' + sym.line));

    var acts = document.createElement('div');
    acts.className = 'acts';

    var expandAll = document.createElement('button');
    expandAll.textContent = 'Open every call here';
    expandAll.addEventListener('click', function () {
      var opened = 0;
      Array.prototype.forEach.call(
        rootGloss.querySelectorAll(':scope > .lines .ref[data-rel="call"]'),
        function (b) {
          if (b.getAttribute('aria-expanded') !== 'true' && b.dataset.targets) {
            b.click();
            opened++;
          }
        });
      if (!opened) toast('Every call in this function is already open.');
    });
    acts.appendChild(expandAll);

    var collapseAll = document.createElement('button');
    collapseAll.textContent = 'Close all';
    collapseAll.addEventListener('click', function () {
      Array.prototype.forEach.call(rootGloss.querySelectorAll('.gloss'), function (g) {
        g.remove();
      });
      Array.prototype.forEach.call(rootGloss.querySelectorAll('.ref[aria-expanded="true"]'),
        function (b) { b.setAttribute('aria-expanded', 'false'); });
    });
    acts.appendChild(collapseAll);

    if (state.history.length) {
      var back = document.createElement('button');
      back.textContent = 'Back';
      back.addEventListener('click', goBack);
      acts.appendChild(back);
    }

    head.appendChild(acts);
    leaf.appendChild(head);

    if (sym.doc) {
      var doc = document.createElement('p');
      doc.className = 'doc';
      doc.textContent = stripCommentMarkers(sym.doc);
      leaf.appendChild(doc);
    }

    var rootGloss = buildGloss(id, 0, []);
    leaf.appendChild(rootGloss);
    host.appendChild(leaf);

    if (autoExpand > 0) {
      var first = rootGloss.querySelector('.ref[data-rel="call"][data-targets]');
      if (first) first.click();
    }
  }

  /**
   * Build the block for one symbol: a head (except at the root, where the
   * leaf header already names it) and one element per source line, with
   * expandable reference anchors in place.
   */
  function buildGloss(id, depth, ancestors) {
    var project = state.project;
    var rendered = L.renderSymbol(project, id);
    var sym = project.symbols[id];

    var box = document.createElement('div');
    box.className = 'gloss';
    box.dataset.sym = String(id);
    box.dataset.depth = String(depth);

    if (depth > 0) {
      var gh = document.createElement('div');
      gh.className = 'glosshead';
      gh.appendChild(spanText('sig', sym.signature || sym.name));
      gh.appendChild(spanText('loc', shortFile(sym.file) + ':' + sym.line));

      if (ancestors.indexOf(id) >= 0) {
        var rec = spanText('loc', '· recursive');
        rec.style.color = 'var(--rubric)';
        gh.appendChild(rec);
      }

      var openFull = document.createElement('button');
      openFull.className = 'open-full';
      openFull.textContent = 'read on its own';
      openFull.title = 'Make ' + sym.name + ' the main text';
      openFull.addEventListener('click', function () { show(id); });
      gh.appendChild(openFull);

      var close = document.createElement('button');
      close.className = 'close';
      close.textContent = 'close';
      close.setAttribute('aria-label', 'Close the gloss for ' + sym.name);
      close.addEventListener('click', function () {
        var anchorId = box.dataset.anchor;
        if (anchorId) {
          var anchor = document.querySelector('[data-anchor-id="' + anchorId + '"]');
          if (anchor) anchor.setAttribute('aria-expanded', 'false');
        }
        box.remove();
      });
      gh.appendChild(close);
      box.appendChild(gh);
    }

    var lines = document.createElement('div');
    lines.className = 'lines';
    box.appendChild(lines);

    var nextAncestors = ancestors.concat([id]);
    var lineNo = rendered.firstLine;
    var current = newLine(lineNo);

    rendered.runs.forEach(function (run) {
      if (run.text === '\n' || run.text === '\r\n' || run.text === '\r') {
        lines.appendChild(current);
        lineNo++;
        current = newLine(lineNo);
        return;
      }
      /* A multi-line token (block comment, continued string) is split so each
       * physical line keeps its own number. */
      if (run.text.indexOf('\n') >= 0) {
        var parts = run.text.split('\n');
        parts.forEach(function (part, i) {
          if (i > 0) {
            lines.appendChild(current);
            lineNo++;
            current = newLine(lineNo);
          }
          if (part !== '') current.querySelector('.src').appendChild(runNode(
            { text: part, kind: run.kind }, depth, nextAncestors));
        });
        return;
      }
      current.querySelector('.src').appendChild(runNode(run, depth, nextAncestors));
    });
    if (current.querySelector('.src').childNodes.length) lines.appendChild(current);

    return box;
  }

  function newLine(n) {
    var ln = document.createElement('div');
    ln.className = 'ln';
    var num = document.createElement('span');
    num.className = 'num';
    num.setAttribute('aria-hidden', 'true');
    num.textContent = String(n);
    var src = document.createElement('span');
    src.className = 'src';
    ln.appendChild(num);
    ln.appendChild(src);
    return ln;
  }

  function runNode(run, depth, ancestors) {
    if (!run.ref) {
      var s = document.createElement('span');
      s.className = 't-' + run.kind;
      s.textContent = run.text;
      return s;
    }

    var ref = run.ref;
    var b = document.createElement('button');
    b.className = 'ref';
    b.textContent = run.text;
    b.dataset.rel = ref.relation;
    b.dataset.anchorId = String(++anchorSeq);

    if (ref.relation === 'indirect-call') {
      b.classList.add('indirect');
      b.title = 'Called through a function pointer. Which function runs here ' +
        'depends on what the struct was initialised with, so lectern will not ' +
        'guess.';
      b.addEventListener('click', function () { toast(b.title); });
      return b;
    }

    if (!ref.targets.length) {
      b.classList.add('unresolved');
      b.title = ref.name + ' is not defined in the files you loaded — a ' +
        'library function, or hidden behind the preprocessor.';
      b.addEventListener('click', function () { toast(b.title); });
      return b;
    }

    var targetId = ref.targets[0];
    b.dataset.targets = ref.targets.join(',');
    b.setAttribute('aria-expanded', 'false');
    var target = state.project.symbols[targetId];
    b.title = (ref.ambiguous ? 'Ambiguous — showing ' : '') +
      (target.signature || target.name) + ' · ' +
      shortFile(target.file) + ':' + target.line;

    if (ref.relation === 'type' || ref.relation === 'macro') {
      b.addEventListener('mouseenter', function () { showMarginal(b, targetId); });
      b.addEventListener('focus', function () { showMarginal(b, targetId); });
      b.addEventListener('mouseleave', hideMarginal);
      b.addEventListener('blur', hideMarginal);
    }

    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      hideMarginal();
      toggleGloss(b, targetId, depth, ancestors, ref);
    });
    return b;
  }

  function toggleGloss(button, targetId, depth, ancestors, ref) {
    if (button.getAttribute('aria-expanded') === 'true') {
      var existing = document.querySelector('.gloss[data-anchor="' + button.dataset.anchorId + '"]');
      if (existing) existing.remove();
      button.setAttribute('aria-expanded', 'false');
      return;
    }

    if (depth + 1 > MAX_GLOSS_DEPTH) {
      toast('Stopping at ' + MAX_GLOSS_DEPTH + ' levels deep. Use "read on ' +
        'its own" to continue from here with a fresh page.');
      return;
    }

    var child = buildGloss(targetId, depth + 1, ancestors);
    child.dataset.anchor = button.dataset.anchorId;

    if (ref.ambiguous && ref.targets.length > 1) {
      var note = document.createElement('div');
      note.className = 'glosshead';
      note.style.color = 'var(--rubric)';
      note.textContent = ref.targets.length + ' definitions share the name ' +
        ref.name + '; showing the first.';
      child.insertBefore(note, child.firstChild);
    }

    var line = button.closest('.ln');
    if (line && line.parentNode) {
      line.parentNode.insertBefore(child, line.nextSibling);
    } else {
      button.parentNode.appendChild(child);
    }
    button.setAttribute('aria-expanded', 'true');
  }

  /* ---- marginal note for types and macros ---- */

  function showMarginal(anchor, id) {
    var project = state.project;
    var sym = project.symbols[id];
    var rec = L.fileOf(project, sym.file);
    if (!rec) return;

    el.marginal.textContent = '';
    var head = document.createElement('div');
    head.className = 'mhead';
    head.textContent = describeKind(sym) + ' · ' + shortFile(sym.file) + ':' + sym.line;
    el.marginal.appendChild(head);

    var pre = document.createElement('pre');
    var text = rec.src.slice(
      rec.tokens[sym.start].i,
      rec.tokens[Math.min(sym.end, rec.tokens.length - 1)].i +
        rec.tokens[Math.min(sym.end, rec.tokens.length - 1)].v.length);
    /* A huge aggregate would push the note off screen; show the head of it. */
    var LIMIT = 2600;
    pre.textContent = text.length > LIMIT
      ? text.slice(0, LIMIT) + '\n… (open it to read the rest)'
      : text;
    el.marginal.appendChild(pre);

    el.marginal.hidden = false;
    var r = anchor.getBoundingClientRect();
    var mw = el.marginal.offsetWidth;
    var mh = el.marginal.offsetHeight;
    var left = Math.min(r.right + 14, window.innerWidth - mw - 10);
    var top = Math.min(r.top, window.innerHeight - mh - 10);
    el.marginal.style.left = Math.max(8, left) + 'px';
    el.marginal.style.top = Math.max(8, top) + 'px';
  }

  function hideMarginal() { el.marginal.hidden = true; }

  /* ===================================================================== *
   * Call tree
   * ===================================================================== */

  function renderTree(id) {
    var project = state.project;
    var host = el.views.tree;
    host.textContent = '';

    var sym = project.symbols[id];
    var intro = document.createElement('div');
    intro.className = 'prose';
    var h = document.createElement('h2');
    h.textContent = 'What ' + sym.name + ' reaches';
    intro.appendChild(h);
    var p = document.createElement('p');
    p.textContent = 'Direct calls first, six levels deep. A branch marked ' +
      'recursive loops back to something already on the path; a branch marked ' +
      'more has callees that are not shown at this depth.';
    intro.appendChild(p);
    host.appendChild(intro);

    if (sym.kind !== 'function' || !sym.definition) {
      var np = document.createElement('p');
      np.className = 'prose';
      np.textContent = describeKind(sym) + ' has no call tree.';
      host.appendChild(np);
      return;
    }

    var tree = L.callTree(project, id, 6);
    var leaf = document.createElement('div');
    leaf.className = 'leaf';
    var lines = document.createElement('div');
    lines.className = 'lines treelines';
    leaf.appendChild(lines);
    walkTree(tree, 0, lines, true);
    host.appendChild(leaf);

    if (!tree.children.length) {
      var q = document.createElement('p');
      q.className = 'prose';
      q.textContent = sym.name + ' calls nothing else that is defined in this project.';
      host.appendChild(q);
    }
  }

  function walkTree(node, depth, host, isRoot) {
    var row = document.createElement('div');
    row.className = 'ln';
    var src = document.createElement('span');
    src.className = 'src';
    src.style.paddingLeft = (depth * 1.5) + 'rem';

    var b = document.createElement('button');
    b.className = 'ref';
    b.textContent = node.symbol.name;
    b.style.borderBottom = '0';
    b.addEventListener('click', function () { show(node.id); });
    src.appendChild(b);

    if (isRoot) src.appendChild(spanText('t-comment', '  ' + describeKind(node.symbol)));
    if (node.cycle) src.appendChild(spanText('t-keyword', '  recursive'));
    if (node.truncated) src.appendChild(spanText('t-comment', '  more'));
    if (!node.cycle && !node.truncated && !node.children.length && !isRoot) {
      src.appendChild(spanText('t-comment', '  leaf'));
    }

    row.appendChild(src);
    host.appendChild(row);
    node.children.forEach(function (c) { walkTree(c, depth + 1, host, false); });
  }

  /* ===================================================================== *
   * Reading order
   * ===================================================================== */

  function renderOrder() {
    var project = state.project;
    var host = el.views.order;
    host.textContent = '';
    var order = project.readingOrder;

    var intro = document.createElement('div');
    intro.className = 'prose';
    var h = document.createElement('h2');
    h.textContent = 'Read it front to back';
    intro.appendChild(h);
    var p1 = document.createElement('p');
    p1.textContent = 'Source files are ordered for the compiler, not for you. ' +
      'This is the same code sorted so that nothing is used before it is ' +
      'defined: types and macros first, then the functions that build on them, ' +
      'then the ones that build on those.';
    intro.appendChild(p1);

    var p2 = document.createElement('p');
    if (order.cycles.length) {
      p2.textContent = 'A strict order is impossible in ' + order.cycles.length +
        ' place' + (order.cycles.length === 1 ? '' : 's') + ': those groups call ' +
        'each other, so one member has to come first and be read on trust. ' +
        'They are marked below — ' + order.backEdges.length + ' reference' +
        (order.backEdges.length === 1 ? '' : 's') + ' point' +
        (order.backEdges.length === 1 ? 's' : '') + ' forward in total.';
    } else {
      p2.textContent = 'This project has no dependency cycles, so the order ' +
        'below is strict: every name is defined before it is used.';
    }
    intro.appendChild(p2);
    host.appendChild(intro);

    var inCycle = new Set();
    var cycleHead = new Map();
    order.cycles.forEach(function (members) {
      members.forEach(function (m) { inCycle.add(m); });
      cycleHead.set(members[0], members);
    });

    var ol = document.createElement('ol');
    ol.className = 'order';

    order.sequence.forEach(function (id) {
      var sym = project.symbols[id];
      var li = document.createElement('li');
      if (inCycle.has(id)) li.classList.add('in-cycle');

      if (cycleHead.has(id)) {
        var note = document.createElement('p');
        note.className = 'cyclenote';
        var names = cycleHead.get(id).map(function (m) {
          return project.symbols[m].name;
        });
        note.textContent = 'Mutually dependent: ' + names.join(' · ') +
          ' — read these together.';
        li.appendChild(note);
      }

      var entry = document.createElement('div');
      entry.className = 'entry';
      var b = document.createElement('button');
      b.textContent = sym.name;
      b.addEventListener('click', function () { show(id); });
      entry.appendChild(b);
      entry.appendChild(spanText('k', describeKind(sym)));
      entry.appendChild(spanText('f', shortFile(sym.file) + ':' + sym.line));
      li.appendChild(entry);
      ol.appendChild(li);
    });

    host.appendChild(ol);
  }

  /* ===================================================================== *
   * Index / health
   * ===================================================================== */

  function renderHealth() {
    var project = state.project;
    var s = L.stats(project);
    var host = el.views.health;
    host.textContent = '';

    var intro = document.createElement('div');
    intro.className = 'prose';
    var h = document.createElement('h2');
    h.textContent = 'What was indexed';
    intro.appendChild(h);
    var p = document.createElement('p');
    p.textContent = 'lectern resolves names the way a reader does, not the way ' +
      'a compiler does: no macro expansion, no #if evaluation. Anything it ' +
      'could not place is listed here rather than guessed at.';
    intro.appendChild(p);
    host.appendChild(intro);

    var cells = [
      ['files', s.files], ['lines', s.lines], ['functions', s.functions],
      ['prototypes', s.prototypes], ['structs & unions', s.structs + s.unions],
      ['enums', s.enums], ['typedefs', s.typedefs], ['macros', s.macros],
      ['file-scope variables', s.variables], ['references resolved', s.edges],
      ['entry points', s.roots], ['leaf functions', s.leaves]
    ];
    var grid = document.createElement('div');
    grid.className = 'grid';
    cells.forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'cell';
      d.appendChild(spanText('n', fmt(c[1])));
      d.appendChild(spanText('l', c[0]));
      grid.appendChild(d);
    });
    host.appendChild(grid);

    if (project.unresolved.length) {
      host.appendChild(sectionHead('Names not defined in these files',
        'Each is a reference lectern left unresolved. Mostly these are libc ' +
        'and platform calls, which is expected; a name you did expect to see ' +
        'here usually means the file defining it was not loaded.'));
      var t = document.createElement('table');
      t.className = 'tbl';
      t.appendChild(tableHead(['name', 'kind', 'times']));
      var tb = document.createElement('tbody');
      project.unresolved.slice(0, 120).forEach(function (u) {
        var tr = document.createElement('tr');
        tr.appendChild(td(u.name, 'm'));
        tr.appendChild(td(u.relation === 'call' ? 'call' : u.relation));
        tr.appendChild(td(fmt(u.count), 'num'));
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      host.appendChild(t);
      if (project.unresolved.length > 120) {
        host.appendChild(para('…and ' + (project.unresolved.length - 120) + ' more.'));
      }
    }

    if (project.diagnostics.length) {
      host.appendChild(sectionHead('Parse notes',
        'Places where the source did not lex cleanly. The index is still ' +
        'usable; these are the spots to distrust.'));
      var t2 = document.createElement('table');
      t2.className = 'tbl';
      t2.appendChild(tableHead(['where', 'note']));
      var tb2 = document.createElement('tbody');
      project.diagnostics.slice(0, 80).forEach(function (d) {
        var tr = document.createElement('tr');
        tr.appendChild(td(shortFile(d.file) + ':' + d.line, 'm'));
        tr.appendChild(td(d.message));
        tb2.appendChild(tr);
      });
      t2.appendChild(tb2);
      host.appendChild(t2);
    } else {
      host.appendChild(para('Every file lexed cleanly.'));
    }
  }

  function sectionHead(title, blurb) {
    var d = document.createElement('div');
    d.className = 'prose';
    d.style.marginTop = '1.6rem';
    var h = document.createElement('h2');
    h.textContent = title;
    d.appendChild(h);
    var p = document.createElement('p');
    p.textContent = blurb;
    p.style.marginBottom = '0';
    d.appendChild(p);
    return d;
  }

  function tableHead(cols) {
    var thead = document.createElement('thead');
    var tr = document.createElement('tr');
    cols.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c;
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    return thead;
  }

  function td(text, cls) {
    var d = document.createElement('td');
    if (cls) d.className = cls;
    d.textContent = text;
    return d;
  }

  function para(text) {
    var p = document.createElement('p');
    p.className = 'prose';
    p.style.marginTop = '.8rem';
    p.textContent = text;
    return p;
  }

  /* ===================================================================== *
   * Search
   * ===================================================================== */

  function wireSearch() {
    el.search.addEventListener('input', function () { runSearch(el.search.value); });
    el.search.addEventListener('focus', function () {
      if (el.search.value) runSearch(el.search.value);
    });
    el.search.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSearch(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSearch(-1); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        var hit = state.searchHits[state.searchIndex] || state.searchHits[0];
        if (hit) { closeSearch(); show(hit.symbol.id); }
      } else if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeSearch();
        el.search.blur();
      }
    });
    document.addEventListener('click', function (ev) {
      if (!el.results.contains(ev.target) && ev.target !== el.search) closeSearch();
    });
  }

  function runSearch(q) {
    if (!state.project || !q.trim()) { closeSearch(); return; }
    var hits = L.searchSymbols(state.project, q.trim(), 50);
    state.searchHits = hits;
    state.searchIndex = hits.length ? 0 : -1;
    el.results.textContent = '';

    if (!hits.length) {
      var d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'Nothing matches “' + q.trim() + '”.';
      el.results.appendChild(d);
    } else {
      hits.forEach(function (hit, i) {
        var b = document.createElement('button');
        b.className = 'result';
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        b.appendChild(spanText('rkind', describeKind(hit.symbol)));
        b.appendChild(spanText('rname', hit.symbol.name));
        b.appendChild(spanText('rwhere', shortFile(hit.symbol.file) + ':' + hit.symbol.line));
        b.addEventListener('click', function () { closeSearch(); show(hit.symbol.id); });
        el.results.appendChild(b);
      });
    }
    el.results.hidden = false;
    el.search.setAttribute('aria-expanded', 'true');
  }

  function moveSearch(delta) {
    var items = el.results.querySelectorAll('.result');
    if (!items.length) return;
    state.searchIndex = (state.searchIndex + delta + items.length) % items.length;
    Array.prototype.forEach.call(items, function (it, i) {
      it.setAttribute('aria-selected', i === state.searchIndex ? 'true' : 'false');
      if (i === state.searchIndex && it.scrollIntoView) {
        it.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function closeSearch() {
    el.results.hidden = true;
    el.search.setAttribute('aria-expanded', 'false');
  }

  /* ===================================================================== *
   * Views, keyboard, chrome
   * ===================================================================== */

  function wireTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { selectView(t.dataset.view); });
    });
  }

  function selectView(name) {
    state.view = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.setAttribute('aria-selected', t.dataset.view === name ? 'true' : 'false');
    });
    Object.keys(el.views).forEach(function (k) { el.views[k].hidden = k !== name; });
  }

  function goBack() {
    if (!state.history.length) return;
    var prev = state.history.pop();
    state.currentId = null;
    show(prev, { pushHistory: false });
  }

  function wireKeyboard() {
    document.addEventListener('keydown', function (ev) {
      var typing = ev.target === el.search;
      if (ev.key === '/' && !typing) {
        ev.preventDefault();
        el.search.focus();
        el.search.select();
        return;
      }
      if (ev.key === 'Escape') {
        if (!el.results.hidden) { closeSearch(); return; }
        if (!el.marginal.hidden) { hideMarginal(); return; }
        goBack();
        return;
      }
      if (typing) return;
      if (ev.key >= '1' && ev.key <= '4') {
        var names = ['read', 'tree', 'order', 'health'];
        selectView(names[Number(ev.key) - 1]);
      }
    });
  }

  var toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 6000);
  }

  /* ===================================================================== *
   * Small helpers
   * ===================================================================== */

  function spanText(cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function describeKind(sym) {
    if (sym.kind === 'function') return sym.definition ? 'function' : 'prototype';
    if (sym.kind === 'macro') return sym.funcLike ? 'macro(…)' : 'macro';
    return sym.kind;
  }

  function shortFile(path) {
    var ix = path.lastIndexOf('/');
    return ix < 0 ? path : path.slice(ix + 1);
  }

  function stripCommentMarkers(doc) {
    return doc.split('\n').map(function (line) {
      return line.replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, '')
        .replace(/^\s*\*\s?/, '').replace(/^\s*\/\/\s?/, '');
    }).join('\n').replace(/^\s+|\s+$/g, '');
  }

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function humanBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' kB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
