/* Assembles src/* into a single self-contained prototype HTML file, and a
   dist/ folder for hosting it as an installable PWA. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const src = p => fs.readFileSync(path.join(root, 'src', p), 'utf8');

const parts = JSON.parse(src('screens.json'));
const css = src('app.css');
const js = src('app.js');
let shell = src('shell.html');

const esc = s => s.replace(/<\/script>/gi, '<\\/script>');

/* ---- screen markup ---- */
const chunks = [];
const meta = [];

for (const p of parts) {
  const push = (id, kind, body, extra = {}) => {
    const cls = kind === 'overlay' ? 'overlay' : 'screen';
    const attrs = kind === 'overlay' ? '' : ` data-tabs="${p.hasTab ? 'on' : 'off'}"`;
    chunks.push(`<div class="${cls}" id="${id}"${attrs}>\n${body}\n</div>`);
    meta.push({
      id,
      title: extra.title || p.title,
      desc: extra.desc || p.desc,
      section: p.section,
      tabs: kind === 'overlay' ? undefined : !!p.hasTab,
      sb: !!p.sbDark,
      overlay: kind === 'overlay'
    });
  };

  if (p.base !== undefined) {
    // screen shipped as base page + overlay layer
    if (p.id === 'ov-job-actions') {
      push('ov-job-actions', 'overlay', p.overlay, {
        title: 'Job actions menu', desc: 'En route / Equipment / Assets / Completed'
      });
    } else {
      push('inv-sent', 'page', p.base, { title: 'Invoice sent', desc: 'Sent state with a chase action' });
      push('ov-inv-share', 'overlay', p.overlay, {
        title: 'Invoice share menu', desc: 'Email / SMS / print / edit'
      });
    }
  } else {
    push(p.id, p.kind, p.body);
  }
}

/* the ov-job-actions base is screen 6 (job-general) — nothing extra to emit */

shell = shell
  .replace('/*__CSS__*/', () => css)
  .replace('<!--SCREENS-->', () => chunks.join('\n\n'))
  .replace('/*__JS__*/', () =>
    'window.__SCREENS__=' + esc(JSON.stringify(meta)) + ';\n' + js);

const BASE_HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Vision 360">`;

const styleEnd = shell.indexOf('</style>') + 8;
const headHTML = shell.slice(0, styleEnd);
const bodyHTML = shell.slice(styleEnd);

function page(extraHead) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${BASE_HEAD}
${extraHead}
${headHTML}
</head>
<body>
${bodyHTML}
</body>
</html>
`;
}

/* ---- standalone deliverable: no PWA plumbing, works from file:// ---- */
const doc = page('');
const out = path.join(root, 'Vision360-Mobile-Prototype.html');
fs.writeFileSync(out, doc);
console.log('wrote', path.relative(root, out), (doc.length / 1024).toFixed(0) + ' KB',
  '·', meta.length, 'design screens');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

/* ---- headless variant, for hosts that supply their own <head> ---- */
fs.writeFileSync(path.join(dist, 'artifact.html'), shell);
console.log('wrote', path.join('dist', 'artifact.html'));

/* ---- PWA icon set ---- */
require('./tools/make-icons.js');

/* ---- manifest ---- */
fs.copyFileSync(path.join(root, 'src', 'manifest.webmanifest'), path.join(dist, 'manifest.webmanifest'));

/* ---- service worker: precache the shell + icon set actually referenced ---- */
const buildId = crypto.createHash('sha256').update(shell).digest('hex').slice(0, 10);
const PRECACHE_ICONS = [
  'icon-192.png', 'icon-512.png', 'icon-192-maskable.png', 'icon-512-maskable.png',
  'apple-touch-icon.png', 'favicon.png'
];
let sw = src('sw.js')
  .replace('__BUILD_ID__', buildId)
  .replace('__ICON_LIST__', PRECACHE_ICONS.map(f => `,\n  './icons/${f}'`).join(''));
fs.writeFileSync(path.join(dist, 'sw.js'), sw);
console.log('wrote', path.join('dist', 'sw.js'), '· cache', buildId);

/* ---- installable site root, with manifest + icons + service worker ---- */
const pwaHead = `<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/favicon.png" sizes="32x32" type="image/png">
<link rel="icon" href="icons/icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">`;
const distDoc = page(pwaHead).replace(
  '</body>',
  `<script>
if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
}
</script>
</body>`
);
fs.writeFileSync(path.join(dist, 'index.html'), distDoc);
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
console.log('wrote', path.join('dist', 'index.html'), '· installable (manifest + service worker)');
