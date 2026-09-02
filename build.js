/* Assembles src/* into a single self-contained prototype HTML file. */
const fs = require('fs');
const path = require('path');

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
    const ovId = p.id === 'ov-job-actions' ? 'ov-job-actions' : 'ov-inv-share';
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

const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Vision 360">
${shell.slice(0, shell.indexOf('</style>') + 8)}
</head>
<body>
${shell.slice(shell.indexOf('</style>') + 8)}
</body>
</html>
`;

const out = path.join(root, 'Vision360-Mobile-Prototype.html');
fs.writeFileSync(out, doc);
console.log('wrote', path.relative(root, out), (doc.length / 1024).toFixed(0) + ' KB',
  '·', meta.length, 'design screens');

/* Same page without the document wrapper, for hosts that supply their own
   <head> (e.g. publishing it as an Artifact). */
const bare = path.join(root, 'dist', 'artifact.html');
fs.mkdirSync(path.dirname(bare), { recursive: true });
fs.writeFileSync(bare, shell);
console.log('wrote', path.relative(root, bare));
