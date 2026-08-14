'use strict';
/**
 * Builds PulseChat.html — the ENTIRE app as a single, downloadable HTML file
 * (inline CSS, inline JS, inline logo, bundled Socket.IO client).
 *
 *   npm run build:standalone
 *
 * The resulting file at public/PulseChat.html works:
 *  - served from the app (http://<host>:3000/PulseChat.html), or
 *  - downloaded and opened anywhere (double-click), talking to any running
 *    PulseChat server via CORS (the login screen has a "server address" field).
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const outFile = path.join(ROOT, 'public', 'PulseChat.html');
const DEFAULT_SERVER = 'http://localhost:3000';

/* 1. Bundle the app JS */
const result = esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'public', 'js', 'app.js')],
  bundle: true,
  format: 'iife',
  write: false,
  minify: false,
  logLevel: 'warning',
});
let js = result.outputFiles[0].text;

/* 2. Inline the logo as a data URI (no external file needed when offline). */
const svg = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'logo.svg'), 'utf8');
const logoDataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
// Bundle references the logo by path in several views:
js = js.split('"/assets/logo.svg"').join('"' + logoDataUri + '"');

/* 3. Inline the Socket.IO client (the bundle calls global `io`). */
let socketClient = null;
for (const p of [
  path.join(ROOT, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js'),
  path.join(ROOT, 'node_modules', 'socket.io-client', 'dist', 'socket.io.js'),
]) {
  if (fs.existsSync(p)) {
    socketClient = fs.readFileSync(p, 'utf8');
    break;
  }
}
if (!socketClient) {
  console.error('Could not find the Socket.IO client bundle. Run `npm install` first.');
  process.exit(1);
}

/* 4. Inline the CSS */
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');

/* 5. Assemble the final file */
const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#0b0e1a">
<meta name="description" content="PulseChat — fast, secure real-time messaging. Text, photos and video calls.">
<title>PulseChat — standalone</title>
<link rel="icon" href="${logoDataUri}">
<style>${css}</style>
</head>
<body>
<div id="app" aria-live="polite"></div>
<div id="toasts"></div>
<div id="modal-root"></div>
<noscript><div style="padding:40px;text-align:center;font-family:sans-serif">PulseChat needs JavaScript to run.</div></noscript>
<script>
  /* Standalone build: point the app at a PulseChat server. */
  window.PC_STANDALONE = true;
  window.PC_SERVER = '${DEFAULT_SERVER}';
  try {
    var saved = localStorage.getItem('pc.server');
    if (saved) window.PC_SERVER = saved;
  } catch (e) {}
</script>
<script>${socketClient}</script>
<script>${js}</script>
</body>
</html>`;

fs.writeFileSync(outFile, html);
console.log(`\n  ✔ Built ${outFile}`);
console.log(`    size: ${(html.length / 1024).toFixed(0)} KB (single file, works offline)`);
console.log(`    default server: ${DEFAULT_SERVER} (changeable on the login screen)\n`);
