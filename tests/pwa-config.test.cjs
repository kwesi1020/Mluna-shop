'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const worker = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');

test('storefront declares a valid install manifest and mobile theme', () => {
  assert.match(html, /rel=["']manifest["'][^>]*href=["']\/manifest\.webmanifest["']/i);
  assert.match(html, /name=["']theme-color["']/i);
  assert.equal(manifest.name, 'MLuna Shop');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.src === '/assets/pwa-icon.svg' && icon.sizes === 'any'));
  assert.equal(fs.existsSync(path.join(root, 'assets/pwa-icon.svg')), true);
});

test('storefront registers the root-scoped service worker', () => {
  assert.match(html, /serviceWorker\.register\(["']\/service-worker\.js["']/);
  assert.match(worker, /self\.addEventListener\(["']install["']/);
  assert.match(worker, /self\.addEventListener\(["']fetch["']/);
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /url\.pathname\.startsWith\('\/admin'\)/);
});
