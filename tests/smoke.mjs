/*
 * Smoke test for both distribution shapes.
 *
 * Runs the served multi-file app and the standalone single-file build
 * through the same checks, so a release can't ship an artifact that fails to
 * boot. Any console error or page error fails the run.
 *
 *   node tests/smoke.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function serve(port) {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

let failures = 0;

function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  (got: ${JSON.stringify(actual)})`}`);
  if (!ok) failures++;
}

async function exercise(page, label) {
  console.log(`\n${label}`);
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

  await page.waitForTimeout(300);

  await page.click('#editor');
  await page.keyboard.type('function hi(name) {\n  return "hey " + name;  // greet\n}\n', { delay: 2 });
  await page.selectOption('#langSelect', 'javascript');
  await page.waitForTimeout(250);

  const tokens = await page.$$eval('.hl-line span', (els) => [...new Set(els.map((e) => e.className))]);
  check('syntax highlighting produces tokens', tokens.length > 0, true);
  check('keyword token present', tokens.some((c) => c.includes('tok-kw')), true);

  const lines = await page.$eval('#statLines', (e) => e.textContent);
  check('line count in status bar', /4 lines/.test(lines), true);

  // Virtualization: a big document must not put every line in the DOM.
  // Loading it over the typed text has to ask first — it can't be undone.
  await page.click('#btnBigFile');
  await page.waitForTimeout(600);
  check('replacing unsaved text asks first', dialogs.some((m) => /unsaved/i.test(m)), true);
  const big = await page.$eval('#statLines', (e) => e.textContent);
  check('sample file loads', /10,000 lines/.test(big), true);
  const nodeCount = await page.$$eval('.gutter-line', (els) => els.length);
  check(`only visible lines rendered (${nodeCount} nodes)`, nodeCount > 0 && nodeCount < 300, true);

  // Search, and every match highlighted.
  await page.keyboard.press('Control+f');
  await page.fill('#searchInput', 'value');
  await page.waitForTimeout(700);
  const status = await page.$eval('#searchStatus', (e) => e.textContent);
  check('search finds matches', /\d+\s*\/\s*\d+/.test(status), true);
  const matchNodes = await page.$$eval('.match', (els) => els.length);
  check(`match highlights stay virtualized (${matchNodes} nodes)`, matchNodes > 0 && matchNodes < 300, true);

  await exerciseEditing(page);

  check('no console or page errors', errors, (e) => e.length === 0);
  if (errors.length) errors.forEach((e) => console.log(`        ${e}`));
}

// Replaces the whole document the way typing would, so the editor sees a
// real beforeinput/input pair rather than a bare .value assignment.
function setDoc(page, text) {
  return page.evaluate((t) => {
    const e = document.getElementById('editor');
    e.focus();
    e.select();
    document.execCommand('insertText', false, t);
  }, text);
}

// Pooled line nodes past the visible window are hidden, not emptied, so
// only lines actually on display count.
const visibleMatches = (page) => page.$$eval('.hl-line .match', (els) =>
  els.filter((e) => e.parentElement.style.display !== 'none').map((e) => e.textContent));

const docState = (page) => page.$eval('#editor', (e) =>
  ({ value: e.value, sel: e.value.slice(e.selectionStart, e.selectionEnd), at: e.selectionStart }));

async function openFind(page, query, { regex = false } = {}) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+f');
  const pressed = await page.$eval('#searchRegexBtn', (b) => b.getAttribute('aria-pressed') === 'true');
  if (pressed !== regex) await page.click('#searchRegexBtn');
  await page.fill('#searchInput', query);
  await page.waitForTimeout(350);
}

async function exerciseEditing(page) {
  console.log('  find & replace');

  await setDoc(page, 'foo a\nfoo b\nfoo c\nfoo d');
  await openFind(page, 'foo');
  await page.click('#searchNext');
  await page.click('#searchNext');
  await page.fill('#replaceInput', 'bar');
  await page.click('#replaceOne');
  await page.waitForTimeout(350);
  let s = await docState(page);
  check('Replace moves on to the next match', s.value === 'foo a\nfoo b\nbar c\nfoo d' && s.at === 18, true);
  check('status follows the replace', await page.$eval('#searchStatus', (e) => e.textContent), '3 / 3');

  await setDoc(page, 'xx foo\nfoo');
  await openFind(page, 'foo');
  // Real keystrokes: execCommand skips beforeinput, which is what tells the
  // editor where an edit landed.
  await page.$eval('#editor', (e) => { e.focus(); e.setSelectionRange(0, 0); });
  await page.keyboard.type('ZZZ');
  await page.evaluate(() => new Promise(requestAnimationFrame)); // one frame, well inside the re-search debounce
  const during = await visibleMatches(page);
  check('highlights follow an edit immediately', during.join(), 'foo,foo');
  await page.waitForTimeout(350);
  s = await docState(page);
  check('re-search after an edit leaves the caret alone', s.at === 3 && s.sel === '', true);
  check('highlights still on the matches', (await visibleMatches(page)).join(), 'foo,foo');

  await setDoc(page, 'price Price');
  await openFind(page, 'price');
  await page.fill('#replaceInput', '$$x $&');
  await page.click('#replaceAll');
  check('plain Replace All inserts "$" literally', (await docState(page)).value, '$$x $& $$x $&');

  await setDoc(page, 'a=1 b=2');
  await openFind(page, '(\\w)=(\\d)', { regex: true });
  await page.fill('#replaceInput', '$2=$1');
  await page.click('#replaceOne');
  await page.waitForTimeout(350);
  check('regex Replace expands capture groups', (await docState(page)).value, '1=a b=2');
  await page.click('#replaceAll');
  check('regex Replace All agrees', (await docState(page)).value, '1=a 2=b');
  await page.keyboard.press('Escape');

  console.log('  files & drafts');

  // A dropped file opens, rather than the browser navigating away to it.
  await setDoc(page, 'scratch');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x = 1\r\ny = 2\r\n'], 'dropped.py'));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  check('a dropped file opens', (await docState(page)).value, 'x = 1\ny = 2\n');
  check('its language is detected', await page.$eval('#statMode', (e) => e.textContent), 'python');
  check('its CRLF endings are kept', await page.$eval('#statEol', (e) => e.textContent), 'CRLF');

  // The draft survives a reload, line endings and "unsaved" flag included.
  await page.click('#editor');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('z = 3');
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForTimeout(400);
  check('draft restored after reload', (await docState(page)).value, 'x = 1\ny = 2\nz = 3');
  check('restored draft keeps CRLF', await page.$eval('#statEol', (e) => e.textContent), 'CRLF');
  check('restored draft still marked unsaved', await page.$eval('#statSaved', (e) => e.textContent), 'Unsaved');
}

// Storage that throws (blocked site data, some private modes) must not stop
// the editor booting — preferences are optional, the editor is not.
async function exerciseNoStorage(browser, url) {
  console.log('\nStorage unavailable');
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForTimeout(300);
  await page.click('#editor');
  await page.keyboard.type('still works');
  await page.click('#btnTheme');
  await page.waitForTimeout(200);
  check('editor boots and edits', await page.$eval('#statCursor', (e) => e.textContent), 'Ln 1, Col 12');
  check('no errors without storage', errors, (e) => e.length === 0);
  await ctx.close();
}

// Save writes back to the file it was opened from; Save As asks where. The
// pickers are stubbed — headless Chromium has no file dialogs — but the
// handles behave like the real API's.
async function exerciseSaveInPlace(browser, url) {
  console.log('\nSave in place (File System Access)');
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const fakeHandle = (name, content) => ({
      kind: 'file', name, writes: [],
      async getFile() { return new File([content], name); },
      async createWritable() {
        const h = this; let buf = '';
        return { async write(t) { buf += t; }, async close() { h.writes.push(buf); } };
      },
    });
    window.__opened = fakeHandle('notes.md', '# Notes\r\n');
    window.__savedAs = fakeHandle('copy.md', '');
    window.__savePickerCalls = 0;
    window.showOpenFilePicker = async () => [window.__opened];
    window.showSaveFilePicker = async () => { window.__savePickerCalls++; return window.__savedAs; };
  });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+o');
  await page.waitForTimeout(200);
  check('opens through the picker', await page.$eval('#editor', (e) => e.value), '# Notes\n');
  await page.click('#editor');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('more');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({ writes: window.__opened.writes, picker: window.__savePickerCalls }));
  check('Save writes back to the opened file', r.writes.join('|'), '# Notes\r\nmore');
  check('…without asking where', r.picker, 0);
  check('status shows saved', await page.$eval('#statSaved', (e) => e.textContent), 'Saved');

  await page.keyboard.press('Control+Shift+s');
  await page.waitForTimeout(200);
  const r2 = await page.evaluate(() => ({ writes: window.__savedAs.writes, picker: window.__savePickerCalls }));
  check('Save As asks where and writes there', r2.picker === 1 && r2.writes.length === 1, true);
  await ctx.close();
}

const PORT = 8971;
const server = await serve(PORT);
const browser = await chromium.launch();

try {
  const served = await browser.newPage();
  await served.goto(`http://localhost:${PORT}/index.html`);
  await exercise(served, 'Served app (multi-file)');

  const single = await browser.newPage();
  await single.goto(`file://${path.join(root, 'dist', 'featherpad.html')}`);
  await exercise(single, 'Standalone build (file://)');

  // The standalone build must keep search on a worker via a blob URL.
  const inlined = await single.evaluate(() => typeof window.__FEATHERPAD_WORKER_SRC__ === 'string');
  console.log('\nStandalone specifics');
  check('worker source is inlined', inlined, true);

  // A blob-backed worker is the whole point: opened from disk, the app would
  // otherwise fall back to searching on the main thread.
  const workers = single.workers();
  check(`search runs on a real worker (${workers.length})`, workers.length >= 1, true);
  check('worker is blob-backed', workers[0]?.url?.().startsWith('blob:') ?? false, true);

  await exerciseNoStorage(browser, `http://localhost:${PORT}/index.html`);
  await exerciseSaveInPlace(browser, `http://localhost:${PORT}/index.html`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
