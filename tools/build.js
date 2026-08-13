#!/usr/bin/env node
/*
 * Builds the standalone single-file editor.
 *
 * Inlines the stylesheet and scripts into one self-contained .html that runs
 * by double-clicking it, on any OS, with no server and no network. The search
 * worker is inlined as a string and started from a blob URL, so even the
 * standalone file keeps search off the main thread.
 *
 *   node tools/build.js [outDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist'));

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Inserting arbitrary text into a <script> block ends it early if the text
// contains "</script>"; escaping the slash keeps the parser out of trouble.
const forScript = (s) => s.replace(/<\/script>/gi, '<\\/script>');

function build() {
  let html = read('index.html');

  const css = read('css/styles.css');
  const highlighter = read('js/highlighter.js');
  const app = read('js/app.js');
  const worker = read('js/search-worker.js');

  // Replacements use function form throughout: inserted file content is
  // arbitrary text, and in string form a stray "$&" or "$1" inside it would
  // be expanded as a substitution pattern rather than inserted literally.
  html = html.replace(
    /<link rel="stylesheet" href="css\/styles\.css">/,
    () => '<style>\n' + css + '\n</style>'
  );

  // No server, so there is no service worker and no manifest to fetch.
  html = html.replace(/^.*<link rel="manifest".*$\n?/m, '');
  html = html.replace(
    /<script>\n\/\/ Offline support[\s\S]*?<\/script>\n?/,
    ''
  );

  html = html.replace(
    /<script src="js\/highlighter\.js"><\/script>\s*<script src="js\/app\.js"><\/script>/,
    () => [
      '<script>',
      'window.__FEATHERPAD_WORKER_SRC__ = ' + forScript(JSON.stringify(worker)) + ';',
      '</script>',
      '<script>',
      forScript(highlighter),
      '</script>',
      '<script>',
      forScript(app),
      '</script>',
    ].join('\n')
  );

  // The icons are only referenced by the installable version.
  html = html.replace(/^.*<link rel="apple-touch-icon".*$\n?/m, '');

  const leftovers = html.match(/(?:src|href)="(?!data:)(?:css|js|icons)\/[^"]+"/g);
  if (leftovers) {
    throw new Error('un-inlined external references remain: ' + leftovers.join(', '));
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'featherpad.html');
  fs.writeFileSync(outFile, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`built ${path.relative(process.cwd(), outFile)}  ${kb} KB`);
  return outFile;
}

build();
