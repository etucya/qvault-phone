// The app shell: the service worker's precache list must name every file under app/, and
// the manifest and page must carry what a home-screen install needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../app/', import.meta.url));
const read = (name) => readFileSync(join(app, name), 'utf8');

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [relative(app, full).split('\\').join('/')];
  });
}

test('the service worker precaches every file under app/ except itself', () => {
  const source = read('sw.js');
  const list = source.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const listed = [...list.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter((p) => p !== '');
  const onDisk = filesUnder(app).filter((p) => p !== 'sw.js');
  assert.deepEqual([...listed].sort(), [...onDisk].sort());
  assert.equal(new Set(listed).size, listed.length, 'no duplicates');
  assert.match(source, /const VERSION = 'qvault-v\d+'/);
});

test('the manifest installs as a standalone QVault with both icons', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.name, 'QVault');
  assert.equal(manifest.short_name, 'QVault');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  const ground = read('theme.css').match(/--ground:\s*(#[0-9a-f]{6})/i)[1];
  assert.equal(manifest.background_color, ground);
  assert.equal(manifest.theme_color, ground);
  assert.deepEqual(manifest.icons.map((i) => i.sizes), ['180x180', '512x512']);
});

test('index.html has the home-screen metas, the GIS script and the module entry', () => {
  const html = read('index.html');
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /rel="apple-touch-icon" href="icons\/icon-180.png"/);
  assert.match(html, /src="https:\/\/accounts.google.com\/gsi\/client"/);
  assert.match(html, /type="module" src="main.js"/);
  assert.match(html, /<main id="app">/);
});

test('icons are real PNGs of the stated sizes', () => {
  for (const size of [180, 512]) {
    const png = readFileSync(join(app, `icons/icon-${size}.png`));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
