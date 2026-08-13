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
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

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
  await page.click('#btnBigFile');
  await page.waitForTimeout(600);
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

  check('no console or page errors', errors, (e) => e.length === 0);
  if (errors.length) errors.forEach((e) => console.log(`        ${e}`));
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
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
