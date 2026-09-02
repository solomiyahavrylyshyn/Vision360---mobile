/* Zero-dependency static server for the prototype.
   Serves dist/ — the installable build (manifest + icons + service worker) —
   so a local run matches what gets deployed.
   node server.js [port]   →   http://localhost:5173
   Run `node build.js` first if dist/ doesn't exist yet. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'dist');
const port = Number(process.argv[2] || process.env.PORT || 5173);
const INDEX = 'index.html';

if (!fs.existsSync(root)) {
  console.error('dist/ not found — run `node build.js` first.');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/' + INDEX;

  const file = path.join(root, path.normalize(rel).replace(/^[\\/]+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}).listen(port, () => {
  console.log('Vision 360 prototype → http://localhost:' + port);
});
