/*
 * Data-driven per-line tokenizer.
 *
 * Languages are declared as compact specs (comment markers, string
 * delimiters, keywords) and compiled once into a single alternation regex.
 * Adding a language is data, not code.
 *
 * Tokenizing is still per line, which is what keeps the virtualized
 * highlight layer cheap: cost scales with the number of *visible* lines,
 * never with file size. Constructs that span lines — block comments,
 * triple-quoted strings, template literals — are handled by threading a
 * small integer state from one line into the next. `scanLine` takes the
 * state at the start of a line and returns the state at its end; the caller
 * owns caching those states (see the block-state cache in app.js).
 */
(function (global) {
  // State encoding: 0 = normal, 1 + i = inside multi-line construct i,
  // where i indexes the language's `spans` array. Packing it into an
  // integer keeps the per-line cache a flat Int32Array.
  const NORMAL = 0;

  const KW = 'tok-kw', STR = 'tok-str', COM = 'tok-com', NUM = 'tok-num', FN = 'tok-fn';

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function words(s) { return s.trim().split(/\s+/); }

  /* ---- Language specs -------------------------------------------------
   * line:     line-comment markers
   * spans:    multi-line constructs [open, close, class]; also matched when
   *           they open and close on the same line
   * strings:  single-line quote delimiters
   * keywords: space-separated
   * extra:    [pattern, class] escape hatch for shapes that aren't
   *           keyword-based (HTML tags, Markdown headings, CSS selectors)
   */
  const C_NUM = true;

  const SPECS = {
    javascript: {
      name: 'JavaScript / TypeScript',
      line: ['//'], spans: [['/*', '*/', COM], ['`', '`', STR]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `const let var function return if else for while do switch case break continue
        class extends new this super import export from default try catch finally throw typeof
        instanceof in of null undefined true false async await yield static get set void delete
        interface type enum implements public private protected readonly namespace declare as satisfies`,
    },
    python: {
      name: 'Python',
      line: ['#'], spans: [['"""', '"""', STR], ["'''", "'''", STR]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `def return if elif else for while class import from as try except finally with
        pass break continue lambda None True False and or not in is yield global nonlocal assert
        del raise async await match case self`,
    },
    json: {
      name: 'JSON', line: [], spans: [], strings: [['"', '"']], numbers: C_NUM,
      keywords: `true false null`,
    },
    html: {
      name: 'HTML', line: [], spans: [['<!--', '-->', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: false, keywords: '',
      extra: [['</?[a-zA-Z][\\w:-]*', KW], ['/?>', KW], ['&[a-zA-Z#][\\w]*;', NUM]],
    },
    xml: {
      name: 'XML', line: [], spans: [['<!--', '-->', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: false, keywords: '',
      extra: [['</?[a-zA-Z][\\w:.-]*', KW], ['/?>', KW], ['&[a-zA-Z#][\\w]*;', NUM]],
    },
    css: {
      name: 'CSS / SCSS', line: ['//'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `important import media keyframes from to and not only supports charset
        font-face include mixin extend use forward if else each for while return`,
      extra: [['#[0-9a-fA-F]{3,8}\\b', NUM], ['[.#][a-zA-Z_-][\\w-]*', FN],
        ['@[a-zA-Z-]+', KW], ['[a-zA-Z-]+(?=\\s*:)', KW]],
    },
    c: {
      name: 'C', line: ['//'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `auto break case char const continue default do double else enum extern float for
        goto if inline int long register restrict return short signed sizeof static struct switch
        typedef union unsigned void volatile while NULL true false bool`,
      extra: [['#\\s*[a-z]+', KW]],
    },
    cpp: {
      name: 'C++', line: ['//'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `alignas alignof and auto bool break case catch char class const constexpr
        const_cast continue decltype default delete do double dynamic_cast else enum explicit
        export extern false float for friend goto if inline int long mutable namespace new
        noexcept nullptr operator or private protected public register reinterpret_cast return
        short signed sizeof static static_assert static_cast struct switch template this throw
        true try typedef typeid typename union unsigned using virtual void volatile while`,
      extra: [['#\\s*[a-z]+', KW]],
    },
    csharp: {
      name: 'C#', line: ['//'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `abstract as base bool break byte case catch char checked class const continue
        decimal default delegate do double else enum event explicit extern false finally fixed
        float for foreach goto if implicit in int interface internal is lock long namespace new
        null object operator out override params private protected public readonly ref return
        sbyte sealed short sizeof stackalloc static string struct switch this throw true try
        typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await`,
    },
    java: {
      name: 'Java', line: ['//'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `abstract assert boolean break byte case catch char class const continue default
        do double else enum extends final finally float for goto if implements import instanceof
        int interface long native new package private protected public return short static
        strictfp super switch synchronized this throw throws transient try var void volatile
        while true false null record sealed permits yield`,
    },
    go: {
      name: 'Go', line: ['//'], spans: [['/*', '*/', COM], ['`', '`', STR]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `break case chan const continue default defer else fallthrough for func go goto
        if import interface map package range return select struct switch type var nil true false
        iota make new len cap append copy delete panic recover string int int8 int16 int32 int64
        uint uint8 uint16 uint32 uint64 float32 float64 bool byte rune error`,
    },
    rust: {
      name: 'Rust', line: ['//'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `as async await break const continue crate dyn else enum extern false fn for if
        impl in let loop match mod move mut pub ref return self Self static struct super trait
        true type unsafe use where while String Vec Option Result Some None Ok Err Box i8 i16
        i32 i64 i128 u8 u16 u32 u64 u128 usize isize f32 f64 bool char str`,
      extra: [['[a-zA-Z_]\\w*!', KW], ["#!?\\[[^\\]]*\\]", COM]],
    },
    ruby: {
      name: 'Ruby', line: ['#'], spans: [['=begin', '=end', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `alias and begin break case class def defined? do else elsif end ensure false for
        if in module next nil not or redo rescue retry return self super then true undef unless
        until when while yield require require_relative attr_accessor attr_reader attr_writer puts`,
      extra: [['[:@$][a-zA-Z_]\\w*', NUM]],
    },
    php: {
      name: 'PHP', line: ['//', '#'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `abstract and array as break callable case catch class clone const continue
        declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch
        endwhile enum extends final finally fn for foreach function global goto if implements
        include include_once instanceof insteadof interface isset list match namespace new or
        print private protected public readonly require require_once return static switch throw
        trait try unset use var while xor yield true false null`,
      extra: [['\\$[a-zA-Z_]\\w*', NUM], ['<\\?php|\\?>', KW]],
    },
    swift: {
      name: 'Swift', line: ['//'], spans: [['/*', '*/', COM]],
      strings: [['"', '"']], numbers: C_NUM,
      keywords: `associatedtype class deinit enum extension fileprivate func import init inout
        internal let open operator private protocol public rethrows static struct subscript typealias
        var break case continue default defer do else fallthrough for guard if in repeat return
        switch where while as Any catch false is nil super self Self throw throws true try
        async await actor some any lazy weak unowned mutating override final convenience required`,
    },
    kotlin: {
      name: 'Kotlin', line: ['//'], spans: [['/*', '*/', COM], ['"""', '"""', STR]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `as break class continue do else false for fun if in interface is null object
        package return super this throw true try typealias typeof val var when while by catch
        constructor delegate dynamic field file finally get import init param property receiver
        set setparam where actual abstract annotation companion const crossinline data enum
        expect external final infix inline inner internal lateinit noinline open operator out
        override private protected public reified sealed suspend tailrec vararg`,
    },
    sql: {
      name: 'SQL', line: ['--'], spans: [['/*', '*/', COM]],
      strings: [["'", "'"], ['"', '"']], numbers: C_NUM, caseInsensitive: true,
      keywords: `select from where insert into values update set delete create table alter drop
        index view join inner left right outer full on group by order having limit offset union
        all distinct as and or not null is in between like exists case when then else end
        primary key foreign references default unique check constraint cascade begin commit
        rollback transaction with recursive returning count sum avg min max coalesce cast
        int integer varchar text boolean date timestamp decimal numeric serial`,
    },
    shell: {
      name: 'Shell / Bash', line: ['#'], spans: [],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `if then else elif fi case esac for while until do done in function select time
        return break continue exit export local readonly declare typeset unset shift eval exec
        source alias set trap echo printf cd pwd test true false`,
      extra: [['\\$\\{?[a-zA-Z_]\\w*\\}?', NUM], ['\\$[0-9@*#?$!]', NUM]],
    },
    yaml: {
      name: 'YAML', line: ['#'], spans: [],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `true false null yes no on off`,
      extra: [['^\\s*-?\\s*[\\w.-]+(?=\\s*:)', KW], ['^\\s*-(?=\\s)', KW], ['&\\w+|\\*\\w+', NUM]],
    },
    toml: {
      name: 'TOML', line: ['#'], spans: [['"""', '"""', STR], ["'''", "'''", STR]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `true false`,
      extra: [['^\\s*\\[+[^\\]]*\\]+', KW], ['^\\s*[\\w.-]+(?=\\s*=)', FN]],
    },
    ini: {
      name: 'INI / Config', line: ['#', ';'], spans: [],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `true false on off yes no`,
      extra: [['^\\s*\\[[^\\]]*\\]', KW], ['^\\s*[\\w.-]+(?=\\s*=)', FN]],
    },
    markdown: {
      name: 'Markdown', line: [], spans: [['```', '```', STR]],
      strings: [], numbers: false, keywords: '',
      extra: [['^#{1,6}\\s.*', KW], ['`[^`]*`', STR], ['\\*\\*[^*]+\\*\\*', KW],
        ['^\\s*[-*+]\\s', NUM], ['^\\s*>\\s?.*', COM], ['\\[[^\\]]*\\]\\([^)]*\\)', FN]],
    },
    lua: {
      name: 'Lua', line: ['--'], spans: [['--[[', ']]', COM], ['[[', ']]', STR]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `and break do else elseif end false for function goto if in local nil not or
        repeat return then true until while self print pairs ipairs require`,
    },
    r: {
      name: 'R', line: ['#'], spans: [],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA
        NA_integer_ NA_real_ NA_character_ library require return invisible`,
    },
    perl: {
      name: 'Perl', line: ['#'], spans: [],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `my our local sub if elsif else unless while until for foreach do return last
        next redo package use require no bless ref defined undef wantarray print printf say
        die warn eval qw qq exists delete keys values push pop shift unshift splice`,
      extra: [['[$@%][a-zA-Z_]\\w*', NUM]],
    },
    dart: {
      name: 'Dart', line: ['//'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `abstract as assert async await break case catch class const continue covariant
        default deferred do dynamic else enum export extends extension external factory false
        final finally for get if implements import in interface is late library mixin new null
        on operator part required rethrow return sealed set show static super switch sync this
        throw true try typedef var void while with yield`,
    },
    scala: {
      name: 'Scala', line: ['//'], spans: [['/*', '*/', COM], ['"""', '"""', STR]],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM,
      keywords: `abstract case catch class def do else extends false final finally for forSome
        if implicit import lazy match new null object override package private protected return
        sealed super this throw trait try true type val var while with yield given using enum
        export extension end then`,
    },
    dockerfile: {
      name: 'Dockerfile', line: ['#'], spans: [],
      strings: [['"', '"'], ["'", "'"]], numbers: C_NUM, caseInsensitive: true,
      keywords: `from run cmd label maintainer expose env add copy entrypoint volume user
        workdir arg onbuild stopsignal healthcheck shell as`,
    },
    makefile: {
      name: 'Makefile', line: ['#'], spans: [],
      strings: [['"', '"'], ["'", "'"]], numbers: false,
      keywords: `ifeq ifneq ifdef ifndef else endif include export unexport define endef
        override private vpath .PHONY .DEFAULT .PRECIOUS .SUFFIXES`,
      extra: [['\\$[({][^)}]*[)}]', NUM], ['^[\\w.%-]+(?=\\s*:)', FN]],
    },
    // Fallback for unknown file types: the shapes nearly every language
    // shares, so an unrecognized file still reads as code rather than a wall
    // of undifferentiated text.
    generic: {
      name: 'Generic code', line: ['//', '#'], spans: [['/*', '*/', COM]],
      strings: [['"', '"'], ["'", "'"], ['`', '`']], numbers: C_NUM,
      keywords: `if else for while do return function func def fn class struct enum interface
        import export from include require use using package module namespace public private
        protected static const let var val final new delete try catch finally throw switch case
        break continue true false null nil none void int float double bool string char and or not`,
    },
  };

  const ALIASES = {
    typescript: 'javascript', jsx: 'javascript', tsx: 'javascript',
    scss: 'css', less: 'css', sass: 'css',
    bash: 'shell', zsh: 'shell', sh: 'shell',
    'c++': 'cpp', 'c#': 'csharp',
  };

  const EXT_MAP = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'javascript', tsx: 'javascript', mts: 'javascript', cts: 'javascript',
    py: 'python', pyw: 'python', pyi: 'python',
    json: 'json', jsonc: 'json', geojson: 'json',
    html: 'html', htm: 'html', vue: 'html', svelte: 'html',
    xml: 'xml', svg: 'xml', xsl: 'xml', plist: 'xml', xaml: 'xml',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
    cs: 'csharp',
    java: 'java',
    go: 'go',
    rs: 'rust',
    rb: 'ruby', gemfile: 'ruby', rake: 'ruby',
    php: 'php', phtml: 'php',
    swift: 'swift',
    kt: 'kotlin', kts: 'kotlin',
    sql: 'sql', psql: 'sql', mysql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
    ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    lua: 'lua',
    r: 'r', rmd: 'r',
    pl: 'perl', pm: 'perl',
    dart: 'dart',
    scala: 'scala', sbt: 'scala',
    txt: 'plain', text: 'plain', log: 'plain',
  };

  // Files identified by name rather than extension.
  const NAME_MAP = {
    dockerfile: 'dockerfile', containerfile: 'dockerfile',
    makefile: 'makefile', gnumakefile: 'makefile',
    gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby',
    '.gitignore': 'ini', '.dockerignore': 'ini', '.npmrc': 'ini', '.editorconfig': 'ini',
    '.bashrc': 'shell', '.zshrc': 'shell', '.bash_profile': 'shell', '.profile': 'shell',
    'cmakelists.txt': 'cpp',
  };

  /* ---- Compilation --------------------------------------------------- */

  const compiled = Object.create(null);

  function compile(spec) {
    const parts = [];
    const kinds = [];

    // Ordering matters: longer/more specific openers must precede shorter
    // ones so that "///" or "--[[" wins over "//" or "--".
    const lines = (spec.line || []).slice().sort((a, b) => b.length - a.length);
    if (lines.length) {
      // The alternation needs its own group, or the trailing .* binds to the
      // last marker only and a comment body goes uncoloured.
      parts.push('((?:' + lines.map(esc).join('|') + ').*)');
      kinds.push({ type: 'line', cls: COM });
    }

    (spec.spans || []).forEach((sp, i) => {
      parts.push('(' + esc(sp[0]) + ')');
      kinds.push({ type: 'span', cls: sp[2], index: i });
    });

    (spec.strings || []).forEach((q) => {
      const open = esc(q[0]), close = esc(q[1]);
      // A complete single-line string, or an unterminated one running to EOL.
      parts.push('(' + open + '(?:[^' + esc(q[1]) + '\\\\\\n]|\\\\.)*(?:' + close + '|$))');
      kinds.push({ type: 'string', cls: STR });
    });

    (spec.extra || []).forEach((ex) => {
      parts.push('(' + ex[0] + ')');
      kinds.push({ type: 'extra', cls: ex[1] });
    });

    const kw = spec.keywords ? words(spec.keywords).filter(Boolean) : [];
    if (kw.length) {
      // Sort long-first so "constexpr" isn't shadowed by "const".
      const sorted = kw.slice().sort((a, b) => b.length - a.length).map(esc);
      parts.push('(\\b(?:' + sorted.join('|') + ')\\b)');
      kinds.push({ type: 'keyword', cls: KW });
    }

    if (spec.numbers) {
      parts.push('(\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)\\b)');
      kinds.push({ type: 'number', cls: NUM });
    }

    const flags = 'gm' + (spec.caseInsensitive ? 'i' : '');
    return {
      spec,
      kinds,
      regex: parts.length ? new RegExp(parts.join('|'), flags) : null,
      spans: spec.spans || [],
    };
  }

  function getLang(lang) {
    const key = ALIASES[lang] || lang;
    if (!SPECS[key]) return null;
    if (!compiled[key]) compiled[key] = compile(SPECS[key]);
    return compiled[key];
  }

  /* ---- Scanning ------------------------------------------------------ */

  function pushSeg(out, text, cls) {
    if (out && text) out.push({ text, cls });
  }

  /*
   * Tokenize one line, given the state it starts in. Returns the segments
   * and the state the next line starts in.
   */
  function scanLine(line, startState, lang) {
    const c = getLang(lang);
    if (!c || !c.regex) return { segments: [{ text: line, cls: null }], endState: NORMAL };
    return walk(line, startState, c, []);
  }

  /*
   * Advance the state across a line without building segments. Used to fill
   * the caller's block-state cache, where only the end state matters —
   * skipping segment construction keeps that bookkeeping allocation-free.
   */
  function nextState(line, startState, lang) {
    const c = getLang(lang);
    if (!c || !c.regex) return NORMAL;
    return walk(line, startState, c, null).endState;
  }

  function walk(line, startState, c, out) {
    let state = startState || NORMAL;
    let i = 0;

    while (true) {
      // Inside a multi-line construct: consume until its closer.
      if (state !== NORMAL) {
        const span = c.spans[state - 1];
        if (!span) { state = NORMAL; continue; }
        const at = line.indexOf(span[1], i);
        if (at === -1) {
          pushSeg(out, line.slice(i), span[2]);
          return { segments: finish(out, line), endState: state };
        }
        pushSeg(out, line.slice(i, at + span[1].length), span[2]);
        i = at + span[1].length;
        state = NORMAL;
      }

      if (i >= line.length) break;

      c.regex.lastIndex = i;
      const m = c.regex.exec(line);
      if (!m) { pushSeg(out, line.slice(i), null); break; }

      if (m.index > i) pushSeg(out, line.slice(i, m.index), null);

      // Which alternative matched? Group k+1 corresponds to kinds[k].
      let k = -1;
      for (let g = 0; g < c.kinds.length; g++) {
        if (m[g + 1] !== undefined) { k = g; break; }
      }
      if (k === -1) { pushSeg(out, line.slice(i), null); break; }

      const kind = c.kinds[k];

      if (kind.type === 'span') {
        const span = c.spans[kind.index];
        const from = m.index + span[0].length;
        const at = line.indexOf(span[1], from);
        if (at === -1) {
          // Opens here and stays open into the next line.
          pushSeg(out, line.slice(m.index), span[2]);
          return { segments: finish(out, line), endState: kind.index + 1 };
        }
        pushSeg(out, line.slice(m.index, at + span[1].length), span[2]);
        i = at + span[1].length;
        continue;
      }

      pushSeg(out, m[0], kind.cls);
      i = m.index + m[0].length;
      if (m[0].length === 0) i++; // zero-width match guard
    }

    return { segments: finish(out, line), endState: state };
  }

  function finish(out, line) {
    if (!out) return null;
    if (out.length === 0) out.push({ text: line, cls: null });
    return out;
  }

  // Back-compat entry point for stateless callers.
  function tokenizeLine(line, lang) {
    return scanLine(line, NORMAL, lang).segments;
  }

  // True when a language has constructs that can span lines, letting the
  // caller skip block-state bookkeeping entirely for those that don't.
  function hasSpans(lang) {
    const c = getLang(lang);
    return !!(c && c.spans && c.spans.length);
  }

  function detectLanguage(filename) {
    if (!filename) return 'plain';
    const base = filename.toLowerCase().split(/[\\/]/).pop();
    if (NAME_MAP[base]) return NAME_MAP[base];
    if (base.startsWith('dockerfile')) return 'dockerfile';
    if (base.startsWith('makefile')) return 'makefile';
    const dot = base.lastIndexOf('.');
    if (dot === -1) return 'plain';
    const ext = base.slice(dot + 1);
    return EXT_MAP[ext] || 'generic';
  }

  // For building the language menu: [{id, name}], alphabetical by label.
  function languageList() {
    return Object.keys(SPECS)
      .map((id) => ({ id, name: SPECS[id].name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  global.Highlighter = {
    NORMAL,
    scanLine,
    nextState,
    tokenizeLine,
    hasSpans,
    detectLanguage,
    languageList,
    supported: Object.keys(SPECS),
  };
})(window);
