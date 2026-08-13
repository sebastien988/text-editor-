/*
 * Lightweight, per-line regex tokenizer.
 *
 * Deliberately stateless (no cross-line tracking of open strings/block
 * comments): each line is tokenized independently in O(line length), which
 * is what makes the virtualized highlight layer cheap — cost only ever
 * scales with the number of *visible* lines, never with file size. The
 * tradeoff is that multi-line block comments/strings aren't perfectly
 * colored; that's an accepted simplification, not a bug.
 */
(function (global) {
  const RULES = {
    javascript: {
      regex: /(\/\/.*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|this|super|import|export|from|default|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|async|await|yield|static|get|set|void|delete)\b)|(\b\d+(?:\.\d+)?\b)/g,
      classify(m) {
        if (m[1] !== undefined) return 'tok-com';
        if (m[2] !== undefined) return 'tok-str';
        if (m[3] !== undefined) return 'tok-kw';
        if (m[4] !== undefined) return 'tok-num';
        return null;
      },
    },
    python: {
      regex: /(#.*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\b(?:def|return|if|elif|else|for|while|class|import|from|as|try|except|finally|with|pass|break|continue|lambda|None|True|False|and|or|not|in|is|yield|global|nonlocal|assert|del|raise|async|await)\b)|(\b\d+(?:\.\d+)?\b)/g,
      classify(m) {
        if (m[1] !== undefined) return 'tok-com';
        if (m[2] !== undefined) return 'tok-str';
        if (m[3] !== undefined) return 'tok-kw';
        if (m[4] !== undefined) return 'tok-num';
        return null;
      },
    },
    json: {
      regex: /("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\bnull\b)|(-?\b\d+(?:\.\d+)?\b)/g,
      classify(m) {
        if (m[1] !== undefined) return 'tok-str';
        if (m[2] !== undefined) return 'tok-kw';
        if (m[3] !== undefined) return 'tok-num';
        return null;
      },
    },
  };

  const EXT_MAP = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'javascript', tsx: 'javascript',
    py: 'python',
    json: 'json',
  };

  function tokenizeLine(line, lang) {
    const rule = RULES[lang];
    if (!rule || line === '') return [{ text: line, cls: null }];

    const regex = rule.regex;
    regex.lastIndex = 0;
    const segments = [];
    let lastIndex = 0;
    let m;
    while ((m = regex.exec(line))) {
      if (m.index > lastIndex) {
        segments.push({ text: line.slice(lastIndex, m.index), cls: null });
      }
      segments.push({ text: m[0], cls: rule.classify(m) });
      lastIndex = m.index + m[0].length;
      if (m[0].length === 0) regex.lastIndex++;
    }
    if (lastIndex < line.length) {
      segments.push({ text: line.slice(lastIndex), cls: null });
    }
    if (segments.length === 0) segments.push({ text: '', cls: null });
    return segments;
  }

  function detectLanguage(filename) {
    if (!filename) return 'plain';
    const ext = filename.split('.').pop().toLowerCase();
    return EXT_MAP[ext] || 'plain';
  }

  global.Highlighter = { tokenizeLine, detectLanguage, supported: Object.keys(RULES) };
})(window);
