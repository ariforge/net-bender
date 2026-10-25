// Renders the extension icons and Chrome Web Store promo images from
// assets/logo.svg using headless Chrome. No npm dependencies.
//
//   node scripts/build-assets.mjs
//
// Set CHROME_PATH if Chrome is not installed in a standard location.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logo = readFileSync(join(root, 'assets', 'logo.svg'), 'utf8');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH.');
  return found;
}

const chrome = findChrome();
const work = mkdtempSync(join(tmpdir(), 'net-bender-assets-'));

function render(html, width, height, out) {
  const page = join(work, `page-${width}x${height}.html`);
  writeFileSync(page, html);
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--user-data-dir=${join(work, 'profile')}`,
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    pathToFileURL(page).href,
  ], { stdio: 'ignore' });
  console.log('wrote', out.replace(root, '.'));
}

// The logo art is drawn on a 96 unit canvas. Toolbar sizes get a hairline of
// padding; the 128px store icon follows Google's guidance of 96px artwork with
// 16px of transparent padding on every side.
function iconHtml(size, pad) {
  const svg = logo.replace(/viewBox="[^"]*"/, `viewBox="${-pad} ${-pad} ${96 + pad * 2} ${96 + pad * 2}"`)
    .replace(/width="96" height="96"/, `width="${size}" height="${size}"`);
  return `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;
}

const icons = [
  { size: 16, pad: 0 },
  { size: 32, pad: 1 },
  { size: 48, pad: 2 },
  { size: 128, pad: 16 },
];
for (const { size, pad } of icons) {
  render(iconHtml(size, pad), size, size, join(root, 'extension', 'icons', `icon${size}.png`));
}

function promoHtml(width, height, scale) {
  const art = logo.replace(/width="96" height="96"/, `width="${Math.round(120 * scale)}" height="${Math.round(120 * scale)}"`);
  return `<!doctype html><html><head><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
    body{display:flex;align-items:center;justify-content:center;gap:${36 * scale}px;
      font-family:"Segoe UI",system-ui,sans-serif;color:#fff;
      background:radial-gradient(circle at 18% 20%,rgba(124,58,237,.55),transparent 55%),
        radial-gradient(circle at 85% 90%,rgba(6,182,212,.45),transparent 55%),#0f1117}
    svg{filter:drop-shadow(0 ${10 * scale}px ${30 * scale}px rgba(0,0,0,.45));flex:none}
    h1{margin:0;font-size:${44 * scale}px;font-weight:800;letter-spacing:-.02em;line-height:1.05}
    p{margin:${10 * scale}px 0 0;font-size:${17 * scale}px;line-height:1.35;color:#c9cbe0;max-width:${330 * scale}px}
    .tags{display:flex;gap:${8 * scale}px;margin-top:${16 * scale}px}
    .tags span{font:600 ${11 * scale}px ui-monospace,Consolas,monospace;padding:${4 * scale}px ${8 * scale}px;border-radius:${5 * scale}px}
    .req{background:rgba(139,92,246,.25);color:#c4b5fd}.res{background:rgba(34,211,238,.2);color:#67e8f9}
  </style></head><body>${art}<div><h1>Net Bender</h1>
    <p>Pause, inspect and edit HTTP requests and responses right in Chrome.</p>
    <div class="tags"><span class="req">INTERCEPT REQUESTS</span><span class="res">INTERCEPT RESPONSES</span></div>
  </div></body></html>`;
}

render(promoHtml(440, 280, 0.72), 440, 280, join(root, 'store', 'promo-small-440x280.png'));
render(promoHtml(1400, 560, 1.9), 1400, 560, join(root, 'store', 'promo-marquee-1400x560.png'));

rmSync(work, { recursive: true, force: true });
