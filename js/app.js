(function () {
  'use strict';

  // ---- DOM refs ------------------------------------------------------
  const editor = document.getElementById('editor');
  const gutter = document.getElementById('gutter');
  const gutterSpacer = document.getElementById('gutterSpacer');
  const codeArea = document.getElementById('codeArea');
  const highlightLayer = document.getElementById('highlightLayer');
  const hlSpacer = document.getElementById('hlSpacer');
  const activeLineEl = document.getElementById('activeLine');

  const btnOpen = document.getElementById('btnOpen');
  const btnSave = document.getElementById('btnSave');
  const fileInput = document.getElementById('fileInput');
  const langSelect = document.getElementById('langSelect');
  const highlightToggle = document.getElementById('highlightToggle');
  const btnFontDown = document.getElementById('btnFontDown');
  const btnFontUp = document.getElementById('btnFontUp');
  const btnTheme = document.getElementById('btnTheme');
  const btnBigFile = document.getElementById('btnBigFile');
  const btnSearch = document.getElementById('btnSearch');

  const searchBar = document.getElementById('searchBar');
  const searchInput = document.getElementById('searchInput');
  const replaceInput = document.getElementById('replaceInput');
  const searchCase = document.getElementById('searchCase');
  const searchRegex = document.getElementById('searchRegex');
  const searchCaseBtn = document.getElementById('searchCaseBtn');
  const searchRegexBtn = document.getElementById('searchRegexBtn');
  const searchPrev = document.getElementById('searchPrev');
  const searchNext = document.getElementById('searchNext');
  const replaceOneBtn = document.getElementById('replaceOne');
  const replaceAllBtn = document.getElementById('replaceAll');
  const searchStatus = document.getElementById('searchStatus');
  const searchClose = document.getElementById('searchClose');

  const statLines = document.getElementById('statLines');
  const statWords = document.getElementById('statWords');
  const statChars = document.getElementById('statChars');
  const statCursor = document.getElementById('statCursor');
  const statSize = document.getElementById('statSize');
  const statSaved = document.getElementById('statSaved');
  const statEol = document.getElementById('statEol');
  const statMode = document.getElementById('statMode');

  // ---- Constants -------------------------------------------------------
  const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20, 22, 24];
  const OVERSCAN = 12; // extra lines rendered above/below viewport
  const AUTOSAVE_KEY = 'featherpad:autosave:v1';
  const AUTOSAVE_MAX_CHARS = 2 * 1024 * 1024;
  const THEME_KEY = 'featherpad:theme';

  // ---- State -------------------------------------------------------
  let filename = null;
  let documentEol = '\n';
  let langState = 'auto';
  let highlightEnabled = true;
  let fontSizeIndex = 2; // 13px
  let lineHeightPx = 21;
  let lineStartsCache = null;
  let lineStartsDirty = true;
  let dirty = false;
  let rafScheduled = false;
  // Declared with the rest of the editor state because render() reads them;
  // keeping them beside the search code risks a temporal-dead-zone error if
  // a frame is ever scheduled before that section initializes.
  let currentMatches = new Int32Array(0);
  let currentMatchIndex = -1;
  let wordCountTimer = null;
  let autosaveTimer = null;

  // ---- Line index ---------------------------------------------------
  // A full rescan is O(document), which at ~13 MB costs ~50 ms — far too
  // slow to run on every keystroke. So the index is maintained
  // incrementally: an edit only rescans the replaced span and shifts the
  // offsets after it. Typing therefore costs O(edited region + lines
  // after it) instead of O(document).
  function computeLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
  }

  function getLineStarts() {
    if (lineStartsDirty) {
      lineStartsCache = computeLineStarts(editor.value);
      lineStartsDirty = false;
    }
    return lineStartsCache;
  }

  // First index whose value is strictly greater than `val`.
  function upperBound(arr, val) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= val) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  const MAX_SPLICE_INSERT = 10000; // avoid unbounded spread-arg stacks

  function applyIncrementalLineStarts(text, start, end, delta) {
    const starts = lineStartsCache;
    if (!starts) return false;

    const newEnd = end + delta;
    if (start < 0 || newEnd < start || newEnd > text.length) return false;

    const from = upperBound(starts, start);
    const to = upperBound(starts, end);

    const inserted = [];
    for (let i = start; i < newEnd; i++) {
      if (text.charCodeAt(i) === 10) {
        inserted.push(i + 1);
        if (inserted.length > MAX_SPLICE_INSERT) return false;
      }
    }

    if (delta !== 0) {
      for (let k = to; k < starts.length; k++) starts[k] += delta;
    }
    starts.splice(from, to - from, ...inserted);
    return true;
  }

  function lineEndOffset(idx, text, starts) {
    return idx + 1 < starts.length ? starts[idx + 1] - 1 : text.length;
  }

  function lineIndexForOffset(offset, starts) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /* ---- Block-state cache ---------------------------------------------
   * Constructs like block comments and triple-quoted strings mean a line's
   * colouring depends on the lines before it, which is in tension with only
   * ever looking at visible lines. The compromise: cache the tokenizer state
   * at the start of each line over a contiguous range, extend it forward as
   * the viewport moves, and truncate it at the first edited line.
   *
   * blockStates[k] is the state entering line (blockBase + k).
   */
  const BLOCK_CATCHUP_MAX = 20000; // forward scan budget before giving up
  const BLOCK_LOOKBEHIND = 1000;   // context scanned when seeding cold
  const BLOCK_CACHE_MAX = 200000;  // bound on retained states

  let blockStates = [Highlighter.NORMAL];
  let blockBase = 0;
  let blockLang = null;

  function resetBlockCache(at) {
    blockBase = Math.max(0, at);
    blockStates = [Highlighter.NORMAL];
  }

  function extendBlockStates(toIdx, text, starts) {
    for (let k = blockStates.length; k <= toIdx; k++) {
      const prev = blockBase + k - 1;
      const lineText = text.slice(starts[prev], lineEndOffset(prev, text, starts));
      blockStates.push(Highlighter.nextState(lineText, blockStates[k - 1], blockLang));
    }
  }

  function blockStateAt(line, text, starts, lang) {
    // Languages without multi-line constructs never need any of this.
    if (!Highlighter.hasSpans(lang)) return Highlighter.NORMAL;

    if (blockLang !== lang) {
      blockLang = lang;
      resetBlockCache(0);
    }

    const idx = line - blockBase;
    if (idx >= 0 && idx < blockStates.length) return blockStates[idx];

    // A jump far past the cache (or backwards) would cost O(document) to
    // resolve exactly. Seed from a bounded window above instead: wrong only
    // if a construct opened more than BLOCK_LOOKBEHIND lines earlier, and
    // bounded work per frame either way.
    if (idx < 0 || idx - blockStates.length > BLOCK_CATCHUP_MAX ||
        blockStates.length > BLOCK_CACHE_MAX) {
      resetBlockCache(line - BLOCK_LOOKBEHIND);
    }

    extendBlockStates(line - blockBase, text, starts);
    return blockStates[line - blockBase];
  }

  // An edit can only change states from its own line onward.
  function invalidateBlocksAt(offset) {
    if (!lineStartsCache) { resetBlockCache(0); return; }
    const line = lineIndexForOffset(offset, lineStartsCache);
    if (line < blockBase) { resetBlockCache(0); return; }
    const keep = line - blockBase + 1;
    if (keep < blockStates.length) blockStates.length = keep;
  }

  // ---- Rendering (virtualized: cost scales with visible lines only) --
  function scheduleRender() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => { rafScheduled = false; render(); });
  }

  function effectiveLang() {
    return langState === 'auto' ? Highlighter.detectLanguage(filename) : langState;
  }

  function render() {
    const text = editor.value;
    const starts = getLineStarts();
    const total = starts.length;
    const totalHeight = total * lineHeightPx;

    gutterSpacer.style.height = totalHeight + 'px';
    hlSpacer.style.height = totalHeight + 'px';

    const digits = String(total).length;
    gutter.style.setProperty('--gutter-width', Math.max(2, digits) * (lineHeightPx * 0.5) + 22 + 'px');

    const scrollTop = editor.scrollTop;
    const clientHeight = editor.clientHeight;
    let startLine = Math.floor(scrollTop / lineHeightPx) - OVERSCAN;
    let endLine = Math.ceil((scrollTop + clientHeight) / lineHeightPx) + OVERSCAN;
    startLine = Math.max(0, Math.min(startLine, total - 1));
    endLine = Math.max(0, Math.min(endLine, total - 1));

    gutter.scrollTop = scrollTop;
    highlightLayer.scrollTop = scrollTop;
    highlightLayer.scrollLeft = editor.scrollLeft;

    const lang = highlightEnabled ? effectiveLang() : 'plain';

    const cursorPos = editor.selectionStart;
    const cursorLine = lineIndexForOffset(cursorPos, starts);
    const visibleCount = endLine - startLine + 1;

    const matchCount = currentMatches.length / 2;
    let matchCursor = matchCount ? firstMatchEndingAfter(starts[startLine]) : 0;

    // State the first visible line starts in (mid block comment, mid
    // triple-quoted string, ...). Only the entry state has to be looked up;
    // the loop below threads it forward across the visible window.
    let lineState = highlightEnabled
      ? blockStateAt(startLine, text, starts, lang)
      : Highlighter.NORMAL;

    // Reuse pooled nodes rather than rebuilding the subtree each frame:
    // scrolling then mutates existing nodes instead of churning the GC.
    const gutterNodes = ensurePool(gutterSpacer, gutterPool, visibleCount, 'gutter-line');
    const hlNodes = highlightEnabled
      ? ensurePool(hlSpacer, hlPool, visibleCount, 'hl-line')
      : ensurePool(hlSpacer, hlPool, 0, 'hl-line');

    for (let n = 0; n < visibleCount; n++) {
      const i = startLine + n;
      const top = (i * lineHeightPx) + 'px';

      const gl = gutterNodes[n];
      const activeCls = i === cursorLine ? 'gutter-line active' : 'gutter-line';
      if (gl.className !== activeCls) gl.className = activeCls;
      if (gl.style.top !== top) gl.style.top = top;
      const label = String(i + 1);
      if (gl.textContent !== label) gl.textContent = label;

      if (highlightEnabled) {
        const hl = hlNodes[n];
        if (hl.style.top !== top) hl.style.top = top;
        const ls = starts[i];
        const le = lineEndOffset(i, text, starts);
        const lineText = text.slice(ls, le);

        // Slice out only the matches touching this line, in line-local
        // coordinates. `matchCursor` walks forward with the visible window,
        // so the whole frame stays O(visible lines + visible matches).
        let lineMatches = null;
        if (matchCount) {
          let mi = matchCursor;
          while (mi < matchCount && currentMatches[mi * 2] < le) {
            const ms = currentMatches[mi * 2], me = currentMatches[mi * 2 + 1];
            if (me > ls) {
              (lineMatches || (lineMatches = [])).push(
                Math.max(ms, ls) - ls, Math.min(me, le) - ls, mi);
            }
            mi++;
          }
          // Matches ending on this line can't affect later ones.
          while (matchCursor < matchCount && currentMatches[matchCursor * 2 + 1] <= le) matchCursor++;
        }

        const scan = Highlighter.scanLine(lineText, lineState, lang);
        lineState = scan.endState;
        renderHighlightedLine(hl, lineText, scan.segments, lineMatches, currentMatchIndex);
      }
    }

    editor.classList.toggle('highlighting-on', highlightEnabled);
    activeLineEl.style.top = (cursorLine * lineHeightPx) + 'px';

    statLines.textContent = total.toLocaleString() + (total === 1 ? ' line' : ' lines');
    statChars.textContent = text.length.toLocaleString() + ' chars';
    statCursor.textContent = 'Ln ' + (cursorLine + 1) + ', Col ' + (cursorPos - starts[cursorLine] + 1);
    statMode.textContent = lang;
  }

  const gutterPool = [];
  const hlPool = [];

  function ensurePool(container, pool, needed, className) {
    while (pool.length < needed) {
      const el = document.createElement('div');
      el.className = className;
      container.appendChild(el);
      pool.push(el);
    }
    for (let i = 0; i < pool.length; i++) {
      const want = i < needed ? '' : 'none';
      if (pool[i].style.display !== want) pool[i].style.display = want;
    }
    return pool;
  }

  // Index of the first match whose end is past `offset`. Matches are
  // produced left to right, so both ends and starts are ascending.
  function firstMatchEndingAfter(offset) {
    let lo = 0, hi = currentMatches.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (currentMatches[mid * 2 + 1] <= offset) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function appendPiece(el, text, cls, isMatch, isCurrent) {
    if (!text) return;
    if (!cls && !isMatch) {
      el.appendChild(document.createTextNode(text));
      return;
    }
    const span = document.createElement('span');
    let className = cls || '';
    if (isMatch) className += (className ? ' ' : '') + (isCurrent ? 'match match-current' : 'match');
    span.className = className;
    span.textContent = text;
    el.appendChild(span);
  }

  // Plain lines are the common case and skip span construction entirely.
  function renderHighlightedLine(el, lineText, segments, matches, currentIdx) {
    if (!matches) {
      if (segments.length === 1 && !segments[0].cls) {
        if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) {
          if (el.firstChild.data !== lineText) el.firstChild.data = lineText;
        } else {
          el.textContent = lineText;
        }
        return;
      }
      el.textContent = '';
      for (const seg of segments) appendPiece(el, seg.text, seg.cls, false, false);
      return;
    }

    // Token runs and match runs are both sorted, so they merge in one pass;
    // a token is split wherever a match boundary falls inside it.
    el.textContent = '';
    const matchTotal = matches.length / 3;
    let pos = 0, mi = 0;
    for (const seg of segments) {
      const segStart = pos, segEnd = pos + seg.text.length;
      pos = segEnd;
      let cur = segStart;
      while (cur < segEnd) {
        while (mi < matchTotal && matches[mi * 3 + 1] <= cur) mi++;
        const ms = mi < matchTotal ? matches[mi * 3] : Infinity;
        if (ms >= segEnd) {
          appendPiece(el, lineText.slice(cur, segEnd), seg.cls, false, false);
          break;
        }
        if (ms > cur) appendPiece(el, lineText.slice(cur, ms), seg.cls, false, false);
        const pieceEnd = Math.min(matches[mi * 3 + 1], segEnd);
        appendPiece(el, lineText.slice(Math.max(cur, ms), pieceEnd), seg.cls,
          true, matches[mi * 3 + 2] === currentIdx);
        cur = pieceEnd;
      }
    }
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ---- Deferred stats -----------------------------------------------
  // Word count and UTF-8 byte size are both O(document). Computing them
  // per frame cost ~390 ms on a 13 MB file (the Blob size call alone was
  // ~127 ms), so they run in one combined pass, debounced, off the hot
  // path — the numbers settle a moment after typing stops.
  function scheduleWordCount() {
    clearTimeout(wordCountTimer);
    wordCountTimer = setTimeout(() => {
      const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
      ric(() => {
        const text = editor.value;
        let words = 0, bytes = 0, inWord = false;
        for (let i = 0; i < text.length; i++) {
          const c = text.charCodeAt(i);
          const ws = c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12;
          if (ws) { inWord = false; } else if (!inWord) { inWord = true; words++; }

          if (c < 0x80) bytes += 1;
          else if (c < 0x800) bytes += 2;
          else if (c >= 0xd800 && c < 0xdc00) bytes += 4; // surrogate pair
          else if (c >= 0xdc00 && c < 0xe000) bytes += 0; // low surrogate counted above
          else bytes += 3;
        }
        statWords.textContent = words.toLocaleString() + (words === 1 ? ' word' : ' words');
        statSize.textContent = formatBytes(bytes);
      });
    }, 400);
  }

  // ---- Dirty / autosave ------------------------------------------
  function markDirty(v) {
    dirty = v;
    statSaved.textContent = v ? 'Unsaved' : 'Saved';
    statSaved.classList.toggle('dirty', v);
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
      ric(() => {
        const text = editor.value;
        // Persisting a huge document costs a serialize + copy on every
        // idle pass and makes the next startup restore it just as slowly,
        // so past this size the draft is intentionally not kept.
        if (text.length > AUTOSAVE_MAX_CHARS) {
          try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) { /* ignore */ }
          return;
        }
        try {
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
            text, filename, lang: langState, ts: Date.now(),
          }));
        } catch (e) { /* quota exceeded — non-fatal */ }
      });
    }, 800);
  }

  function restoreAutosave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (typeof data.text !== 'string') return;
      editor.value = data.text;
      filename = data.filename || null;
      langState = data.lang || 'auto';
      langSelect.value = langState;
    } catch (e) { /* ignore corrupt autosave */ }
  }

  // ---- Input / keyboard ------------------------------------------
  // `beforeinput` is the only place the pre-edit selection is still known,
  // which is what makes the incremental index update possible.
  let pendingEdit = null;
  editor.addEventListener('beforeinput', (e) => {
    const it = e.inputType || '';
    // Undo/redo can rewrite an unknown span, so those fall back to a rescan.
    if (it === 'historyUndo' || it === 'historyRedo' || lineStartsDirty || !lineStartsCache) {
      pendingEdit = null;
      return;
    }
    pendingEdit = {
      start: editor.selectionStart,
      end: editor.selectionEnd,
      oldLen: editor.value.length,
    };
  });

  function onInput() {
    const text = editor.value;
    const editStart = pendingEdit ? pendingEdit.start : 0;
    if (pendingEdit) {
      const delta = text.length - pendingEdit.oldLen;
      if (!applyIncrementalLineStarts(text, pendingEdit.start, pendingEdit.end, delta)) {
        lineStartsDirty = true;
      }
    } else {
      lineStartsDirty = true;
    }
    invalidateBlocksAt(editStart);
    pendingEdit = null;

    scheduleRender();
    scheduleAutosave();
    scheduleWordCount();
    markDirty(true);
  }

  function handleTab(outdent) {
    const val = editor.value;
    const start = editor.selectionStart, end = editor.selectionEnd;
    if (start === end && !outdent) {
      document.execCommand('insertText', false, '  ');
      return;
    }
    const starts = getLineStarts();
    const lineStartIdx = lineIndexForOffset(start, starts);
    const lineEndIdx = lineIndexForOffset(Math.max(end - 1, start), starts);
    const blockStart = starts[lineStartIdx];
    const blockEnd = lineEndOffset(lineEndIdx, val, starts);
    const block = val.slice(blockStart, blockEnd);
    const lines = block.split('\n');
    const newLines = outdent
      ? lines.map((l) => l.replace(/^(  |\t)/, ''))
      : lines.map((l) => '  ' + l);
    const newBlock = newLines.join('\n');
    editor.setSelectionRange(blockStart, blockEnd);
    document.execCommand('insertText', false, newBlock);
    editor.setSelectionRange(blockStart, blockStart + newBlock.length);
  }

  function handleSmartHome() {
    const val = editor.value;
    const starts = getLineStarts();
    const pos = editor.selectionStart;
    const idx = lineIndexForOffset(pos, starts);
    const lineStart = starts[idx];
    const lineEnd = lineEndOffset(idx, val, starts);
    const lineText = val.slice(lineStart, lineEnd);
    const firstNonWs = lineStart + (lineText.match(/^\s*/)[0].length);
    const target = pos === firstNonWs ? lineStart : firstNonWs;
    editor.setSelectionRange(target, target);
    return true;
  }

  editor.addEventListener('input', onInput);
  editor.addEventListener('scroll', scheduleRender);
  editor.addEventListener('keyup', scheduleRender);
  editor.addEventListener('click', scheduleRender);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); handleTab(e.shiftKey); }
    else if (e.key === 'Home' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (handleSmartHome()) e.preventDefault();
    }
  });

  window.addEventListener('resize', scheduleRender);
  new ResizeObserver(scheduleRender).observe(codeArea);

  // ---- Font size / theme ------------------------------------------
  function applyFontSize() {
    const fs = FONT_SIZES[fontSizeIndex];
    lineHeightPx = Math.round(fs * 1.6);
    document.documentElement.style.setProperty('--font-size', fs + 'px');
    document.documentElement.style.setProperty('--line-height-px', lineHeightPx + 'px');
    scheduleRender();
  }

  btnFontUp.addEventListener('click', () => {
    fontSizeIndex = Math.min(FONT_SIZES.length - 1, fontSizeIndex + 1);
    applyFontSize();
  });
  btnFontDown.addEventListener('click', () => {
    fontSizeIndex = Math.max(0, fontSizeIndex - 1);
    applyFontSize();
  });

  btnTheme.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
  });

  langSelect.addEventListener('change', () => {
    langState = langSelect.value;
    scheduleRender();
  });

  highlightToggle.addEventListener('change', () => {
    highlightEnabled = highlightToggle.checked;
    scheduleRender();
  });

  // ---- File open / save ------------------------------------------
  btnOpen.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    statSaved.textContent = 'Loading…';
    const text = await file.text();
    loadText(text, file.name);
    statSaved.textContent = 'Saved';
  });

  // Windows files arrive as CRLF. A stray \r would sit at the end of every
  // line and throw off column numbers and search offsets, so text is
  // normalized to \n internally and converted back on save.
  function normalizeEol(text) {
    if (text.indexOf('\r') === -1) return { text, eol: '\n' };
    const hadCrlf = text.indexOf('\r\n') !== -1;
    return { text: text.replace(/\r\n?/g, '\n'), eol: hadCrlf ? '\r\n' : '\r' };
  }

  function setEol(eol) {
    documentEol = eol;
    statEol.textContent = eol === '\r\n' ? 'CRLF' : (eol === '\r' ? 'CR' : 'LF');
  }

  statEol.addEventListener('click', () => {
    setEol(documentEol === '\n' ? '\r\n' : '\n');
    markDirty(true);
  });

  function loadText(rawText, name) {
    const { text, eol } = normalizeEol(rawText);
    setEol(eol);
    editor.value = text;
    filename = name;
    if (langState === 'auto') langSelect.value = 'auto';
    lineStartsDirty = true;
    resetBlockCache(0);
    markDirty(false);
    scheduleRender();
    scheduleWordCount();
  }

  async function saveFile() {
    const text = documentEol === '\n'
      ? editor.value
      : editor.value.split('\n').join(documentEol);
    const name = filename || 'untitled.txt';
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        filename = handle.name;
        markDirty(false);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        // fall through to download fallback
      }
    }
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    markDirty(false);
  }
  btnSave.addEventListener('click', saveFile);

  // ---- Big sample generator (demonstrates virtualization at scale) --
  function generateBigSample(totalLines) {
    const arr = new Array(totalLines);
    const patterns = [
      (i) => `const value_${i} = ${i} * 2; // computed`,
      (i) => `function fn_${i}(x) { return x + ${i}; }`,
      (i) => `// comment line number ${i}`,
      (i) => `if (value_${i % 1000} > 10) { doSomething(${i}); }`,
    ];
    for (let i = 0; i < totalLines; i++) arr[i] = patterns[i % patterns.length](i);
    return arr.join('\n');
  }

  btnBigFile.addEventListener('click', () => {
    const text = generateBigSample(10000);
    loadText(text, 'sample-10k.js');
    langState = 'javascript';
    langSelect.value = 'javascript';
    scheduleRender();
  });

  // ---- Search / replace (offloaded to a Web Worker) ------------------
  // Opening the page straight off the filesystem (file://) blocks worker
  // construction, so search transparently falls back to running inline.
  let searchWorker = null;
  let searchWorkerOk = false;
  try {
    searchWorker = new Worker('js/search-worker.js');
    searchWorkerOk = true;
    searchWorker.onmessage = (e) => handleSearchResult(e.data);
    searchWorker.onerror = (e) => {
      e.preventDefault();
      searchWorkerOk = false;
      searchWorker = null;
      runSearch();
    };
  } catch (e) {
    searchWorkerOk = false;
  }

  let requestIdCounter = 0;
  let searchDebounce = null;

  function runSearchSync(payload) {
    const { text, query, caseSensitive, useRegex } = payload;
    const pairs = [];
    try {
      if (useRegex) {
        const re = new RegExp(query, caseSensitive ? 'g' : 'gi');
        let m, guard = 0;
        while ((m = re.exec(text))) {
          pairs.push(m.index, m.index + (m[0].length || 1));
          if (m[0].length === 0) re.lastIndex++;
          if (++guard > 200000) break;
        }
      } else {
        const hay = caseSensitive ? text : text.toLowerCase();
        const needle = caseSensitive ? query : query.toLowerCase();
        let idx = 0;
        while ((idx = hay.indexOf(needle, idx)) !== -1) {
          pairs.push(idx, idx + needle.length);
          idx += needle.length;
        }
      }
    } catch (err) {
      return { requestId: payload.requestId, error: String(err.message || err) };
    }
    return { requestId: payload.requestId, pairs: Int32Array.from(pairs), truncated: false };
  }

  function runSearch() {
    const query = searchInput.value;
    if (!query) {
      currentMatches = new Int32Array(0);
      currentMatchIndex = -1;
      updateSearchStatus(false);
      scheduleRender();
      return;
    }
    const id = ++requestIdCounter;
    const payload = {
      text: editor.value, query,
      caseSensitive: searchCase.checked, useRegex: searchRegex.checked,
      requestId: id,
    };
    if (searchWorkerOk) searchWorker.postMessage(payload);
    else handleSearchResult(runSearchSync(payload));
  }

  function handleSearchResult(data) {
    if (data.requestId !== requestIdCounter) return; // stale response
    if (data.error) { searchStatus.textContent = 'Invalid regex'; return; }
    currentMatches = data.pairs;
    currentMatchIndex = currentMatches.length ? 0 : -1;
    updateSearchStatus(data.truncated);
    if (currentMatchIndex >= 0) selectMatch(currentMatchIndex, true);
    else scheduleRender();
  }

  function updateSearchStatus(truncated) {
    const n = currentMatches.length / 2;
    searchStatus.textContent = n ? `${currentMatchIndex + 1} / ${n}${truncated ? '+' : ''}` : (searchInput.value ? 'No results' : '');
  }

  function selectMatch(i, scroll) {
    const start = currentMatches[i * 2], end = currentMatches[i * 2 + 1];
    editor.focus();
    editor.setSelectionRange(start, end);
    if (scroll) scrollOffsetIntoView(start);
    scheduleRender();
  }

  function scrollOffsetIntoView(offset) {
    const starts = getLineStarts();
    const idx = lineIndexForOffset(offset, starts);
    const targetTop = idx * lineHeightPx;
    const viewTop = editor.scrollTop, viewBottom = viewTop + editor.clientHeight;
    if (targetTop < viewTop || targetTop > viewBottom - lineHeightPx * 2) {
      editor.scrollTop = Math.max(0, targetTop - editor.clientHeight / 2);
    }
  }

  function openSearch() {
    searchBar.classList.remove('hidden');
    const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (sel && !sel.includes('\n')) searchInput.value = sel;
    searchInput.focus();
    searchInput.select();
    runSearch();
  }

  function closeSearch() {
    searchBar.classList.add('hidden');
    currentMatches = new Int32Array(0);
    currentMatchIndex = -1;
    editor.focus();
    scheduleRender();
  }

  btnSearch.addEventListener('click', openSearch);
  searchClose.addEventListener('click', closeSearch);

  [searchInput, searchCase, searchRegex].forEach((el) => {
    el.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(runSearch, 120);
    });
  });

  // The case/regex options are capsule toggle buttons driving hidden
  // checkboxes, which stay the single source of truth for search state.
  [[searchCaseBtn, searchCase], [searchRegexBtn, searchRegex]].forEach(([btn, box]) => {
    btn.addEventListener('click', () => {
      box.checked = !box.checked;
      btn.setAttribute('aria-pressed', String(box.checked));
      box.dispatchEvent(new Event('input'));
    });
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    (e.shiftKey ? searchPrev : searchNext).click();
  });

  searchNext.addEventListener('click', () => {
    if (!currentMatches.length) return;
    currentMatchIndex = (currentMatchIndex + 1) % (currentMatches.length / 2);
    updateSearchStatus(false);
    selectMatch(currentMatchIndex, true);
  });
  searchPrev.addEventListener('click', () => {
    if (!currentMatches.length) return;
    const n = currentMatches.length / 2;
    currentMatchIndex = (currentMatchIndex - 1 + n) % n;
    updateSearchStatus(false);
    selectMatch(currentMatchIndex, true);
  });

  replaceOneBtn.addEventListener('click', () => {
    if (currentMatchIndex < 0) return;
    const start = currentMatches[currentMatchIndex * 2], end = currentMatches[currentMatchIndex * 2 + 1];
    editor.focus();
    editor.setSelectionRange(start, end);
    document.execCommand('insertText', false, replaceInput.value);
    runSearch();
  });

  function showUndoReplace(prevText) {
    let btn = document.getElementById('undoReplace');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'undoReplace';
      replaceAllBtn.insertAdjacentElement('afterend', btn);
    }
    btn.textContent = 'Undo replace';
    btn.onclick = () => {
      editor.value = prevText;
      lineStartsDirty = true;
      resetBlockCache(0);
      markDirty(true);
      scheduleRender(); scheduleWordCount(); scheduleAutosave();
      btn.remove();
      runSearch();
    };
  }

  replaceAllBtn.addEventListener('click', () => {
    const query = searchInput.value;
    if (!query) return;
    const text = editor.value;
    let newText;
    try {
      if (searchRegex.checked) {
        newText = text.replace(new RegExp(query, searchCase.checked ? 'g' : 'gi'), replaceInput.value);
      } else if (searchCase.checked) {
        newText = text.split(query).join(replaceInput.value);
      } else {
        const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        newText = text.replace(new RegExp(esc, 'gi'), replaceInput.value);
      }
    } catch (e) {
      searchStatus.textContent = 'Invalid regex';
      return;
    }
    if (newText === text) return;
    showUndoReplace(text);
    editor.value = newText;
    lineStartsDirty = true;
    resetBlockCache(0);
    markDirty(true);
    scheduleRender(); scheduleWordCount(); scheduleAutosave();
    runSearch();
  });

  // ---- Global shortcuts ------------------------------------------
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
    else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); fileInput.click(); }
    else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); }
    else if (e.key === 'Escape' && !searchBar.classList.contains('hidden')) { closeSearch(); }
  });

  function populateLanguageMenu() {
    const frag = document.createDocumentFragment();
    for (const { id, name } of Highlighter.languageList()) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      frag.appendChild(opt);
    }
    langSelect.appendChild(frag);
  }

  // ---- Init ------------------------------------------------------
  (function init() {
    populateLanguageMenu();
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

    restoreAutosave();
    applyFontSize();
    markDirty(false);
    scheduleRender();
    scheduleWordCount();
  })();
})();
