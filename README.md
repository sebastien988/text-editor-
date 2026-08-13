# Featherpad

A fast, dependency-free text editor that runs in the browser. No build step, no
`node_modules`, no framework — three JS files, one CSS file, one HTML file.

Minimalist monochrome interface: the chrome recedes to hairlines and ghost
icon buttons so the text carries all the visual weight. Light and dark themes,
SF Pro / SF Mono on macOS with fallbacks that look right on Windows and Linux.

## Running it

**Windows** — double-click `start.bat`.
**macOS / Linux** — run `./start.sh`.

Both serve the folder on `http://localhost:8080` and open a browser. You can
also just open `index.html` directly; the only difference is that search runs on
the main thread instead of in a worker, because `file://` blocks Web Workers.

Nothing is installed, and no file leaves your machine.

## Features

- Syntax highlighting for 30 languages, with multi-line comments and strings
  tracked correctly, plus a generic fallback so unknown file types still read
  as code
- Find & replace with regex, case sensitivity, and match stepping, with every
  match highlighted at once
- Open/save real files (File System Access API, with a download fallback)
- Line numbers, active-line highlight, live cursor position and document stats
- Light/dark themes, adjustable font size
- Auto-indent-aware Tab/Shift-Tab across a selection, smart Home
- CRLF/LF detection with round-trip-safe saving, switchable from the status bar
- Draft autosave to `localStorage`

## Languages

C, C#, C++, CSS/SCSS/Less, Dart, Dockerfile, Generic code, Go, HTML, INI/Config,
JSON, Java, JavaScript/TypeScript, Kotlin, Lua, Makefile, Markdown, PHP, Perl,
Python, R, Ruby, Rust, SQL, Scala, Shell/Bash, Swift, TOML, XML, YAML.

The mode is picked from the file extension, or from the filename for files that
don't have one (`Dockerfile`, `Makefile`, `.bashrc`). Anything unrecognized falls
back to a generic mode that colors the comment, string, keyword, and number
shapes nearly every language shares, so an unknown file still reads as code. You
can always override the choice from the toolbar.

Adding a language is data rather than code — a spec in `js/highlighter.js`:

```js
elixir: {
  name: 'Elixir',
  line: ['#'], spans: [['"""', '"""', STR]],
  strings: [['"', '"'], ["'", "'"]], numbers: true,
  keywords: `def defmodule do end if else case cond fn when nil true false`,
},
```

## Performance

The design goal was that **rendering cost should not depend on file size**.

**Virtualized rendering.** Only the lines actually on screen get DOM nodes —
about 50-60 of them, whatever the document size. A 300,000-line file renders the
same ~50 nodes as a 10-line one, and those nodes are pooled and mutated in place
rather than rebuilt, so scrolling doesn't churn the GC. Measured on a
100,000-line file: **1.2 ms per rendered frame** for plain text, **2.5 ms** for
highlighted code — flat with file size, and well inside a 16.7 ms frame budget.

**Incremental line indexing.** Mapping character offsets to line numbers needs an
index of line-start positions. Rebuilding it costs O(document) — ~51 ms on a
13 MB file, which is far too slow to run on every keystroke. Instead an edit
rescans only the replaced span and shifts the offsets after it, so typing costs
O(edit size) rather than O(document).

**Stats off the hot path.** Word count and UTF-8 byte size are both O(document);
the byte size alone cost ~127 ms per frame when computed with `new Blob([text])`.
They now run together in a single debounced idle pass, so the numbers settle a
moment after typing stops instead of taxing every keystroke.

**Search in a Web Worker.** Scanning happens off the main thread and results come
back as a transferred `Int32Array` of offset pairs — no copy, no main-thread
stall. Searching 2,500 matches in a 10,000-line file stays interactive.

**Virtualized match highlighting.** Every match is highlighted, but only the ones
intersecting the visible window are ever built. On a 10,000-line file with 5,000
live matches the DOM holds ~27 highlight nodes rather than 5,000, and the render
frame stays at 1.6 ms.

**Per-line tokenizing.** Languages are declared as compact specs — comment
markers, string delimiters, keywords — compiled once into a single alternation
regex. Each line is tokenized on its own, so highlighting scales with visible
lines rather than file size.

**Bounded cross-line state.** Block comments and triple-quoted strings break the
"each line is independent" assumption: whether line 900 is code or comment can
depend on line 40. The tokenizer threads a small integer state from each line to
the next, and the editor caches the state entering each line, extending that
cache forward as you scroll and truncating it at the first edited line. Costs on
a 100,000-line C file with block comments throughout:

| Action | Per rendered frame |
|---|---|
| Sequential scrolling | 3.5 ms |
| Jump to line 100,000 (cold) | 9.0 ms, once |
| Sustained scrolling after that jump | 2.9 ms |

Resolving a cold jump exactly would mean scanning every preceding line, so
instead it seeds from a 1,000-line window above the viewport. That is wrong only
if a block comment opened more than 1,000 lines earlier and is still open — and
it keeps the work per frame bounded rather than proportional to file size.
Languages with no multi-line constructs (JSON, YAML, shell) skip the machinery
entirely.

### Measured results

Typing latency, Chromium, sample JavaScript file:

| Document | Before | After | Bare `<textarea>` floor |
|---|---|---|---|
| 5,000 lines | — | 16.7 ms/char | 15.3 ms/char |
| 10,000 lines | — | 27.2 ms/char | ~28 ms/char |
| 50,000 lines | — | 151.5 ms/char | 155.5 ms/char |
| 300,000 lines | 1,430 ms/char | ~1,000 ms/char | ~1,000 ms/char |

The "bare textarea floor" column is an empty page containing nothing but a
`<textarea>` with the same content and **zero JavaScript attached**. The editor
now sits on top of that floor at every size, meaning its own overhead has been
optimized down to roughly nothing — what remains is the browser's native cost.

### The honest limitation

That floor is also the ceiling. A native `<textarea>` gets linearly slower as its
content grows — about 15 ms/char at 5k lines and 385 ms/char at 100k — because
the browser lays out the entire control on each edit. No amount of JavaScript
tuning (or Rust/WebAssembly, which wouldn't touch DOM layout at all) changes
that; only replacing the textarea does.

So Featherpad is genuinely fast for the files people actually edit — **up to
~10,000 lines it stays comfortably under 30 ms/char** — and scrolling, search,
and highlighting stay fast at any size. But typing in a 300,000-line file is
slow, and that is a property of the architecture, not a bug to be tuned away.
The bundled sample button loads 10,000 lines because that reflects what the
editor is actually good at.

Getting past it means what CodeMirror and Monaco do: drop the real textarea,
keep a tiny hidden one for IME and clipboard, and implement cursor, selection,
hit-testing, and undo by hand. That's a rewrite of the input layer, not an
optimization, and it isn't done here.

## Layout

```
index.html            markup and toolbar
css/styles.css        minimalist theming, light + dark
js/app.js             virtualized rendering, line index, editing, file I/O
js/highlighter.js     language specs and the per-line tokenizer
js/search-worker.js   off-main-thread search
```

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open | `Ctrl/Cmd+O` |
| Save | `Ctrl/Cmd+S` |
| Find | `Ctrl/Cmd+F` |
| Close find | `Esc` |
| Indent / outdent selection | `Tab` / `Shift+Tab` |
| Smart home | `Home` |
| Next / previous match | `Enter` / `Shift+Enter` |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |

Undo and redo are the browser's native textarea history: edits go through
`insertText` rather than assigning `.value`, which keeps that history intact.
Replace All is the one exception — it rewrites the whole document, so it offers
its own "Undo replace" button in the find bar.
