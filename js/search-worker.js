/*
 * Runs search off the main thread so typing/scrolling never stalls while a
 * large document is scanned. Results are returned as a single Int32Array of
 * [start0, end0, start1, end1, ...] pairs and transferred (not copied) back
 * to the main thread.
 */
const MAX_MATCHES = 200000;

self.onmessage = (e) => {
  const { text, query, caseSensitive, useRegex, requestId } = e.data;

  if (!query) {
    self.postMessage({ requestId, pairs: new Int32Array(0), truncated: false }, []);
    return;
  }

  const pairs = [];
  let truncated = false;

  try {
    if (useRegex) {
      const flags = caseSensitive ? 'g' : 'gi';
      const re = new RegExp(query, flags);
      let m;
      let guard = 0;
      while ((m = re.exec(text))) {
        pairs.push(m.index, m.index + (m[0].length || 1));
        if (m[0].length === 0) re.lastIndex++;
        if (pairs.length / 2 >= MAX_MATCHES) { truncated = true; break; }
        if (++guard > 5_000_000) { truncated = true; break; }
      }
    } else {
      const haystack = caseSensitive ? text : text.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      let idx = 0;
      while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        pairs.push(idx, idx + needle.length);
        idx += needle.length;
        if (pairs.length / 2 >= MAX_MATCHES) { truncated = true; break; }
      }
    }
  } catch (err) {
    self.postMessage({ requestId, error: String(err && err.message || err) });
    return;
  }

  const out = Int32Array.from(pairs);
  self.postMessage({ requestId, pairs: out, truncated }, [out.buffer]);
};
