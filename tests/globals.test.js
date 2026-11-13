'use strict';
// Renders real tab pages through PHP (tests/render-tab.php), then runs the page's inline script in a vm sandbox with a
// stub DOM: checks that [HOST] resolves to the hostname the GUI is viewed on, that an http app under an https GUI is
// replaced by the message, that "Open full page" gets the resolved URL, and that nothing leaks into the global scope.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const core = require('../plugin/app-tabs-core.js');

let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apptabs-glob-'));
fs.mkdirSync(dir + '/cfg'); fs.mkdirSync(dir + '/pages');
function render(tabs, slug) {
  fs.writeFileSync(dir + '/cfg/tabs.json', JSON.stringify({ version: 1, tabs }));
  return execFileSync('php', [path.join(__dirname, 'render-tab.php'), slug], { env: { PATH: process.env.PATH, APPTABS_CONFIG_DIR: dir + '/cfg', APPTABS_PAGES_DIR: dir + '/pages' } }).toString();
}

function el(attrs) {
  const e = { hidden: false, style: {}, offsetHeight: 0, href: '', src: '', _attrs: attrs || {}, getAttribute(k) { return this._attrs[k]; }, getBoundingClientRect() { return { top: 100 }; }, insertAdjacentText(_p, txt) { e.text = txt; } };
  return e;
}

function run(html, { protocol = 'http:', hostname = 'nas.local' } = {}) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 1, 'exactly one inline script');
  const dataAttrs = {};
  for (const m of html.matchAll(/data-(url|open|label)="([^"]*)"/g)) dataAttrs['data-' + m[1]] = m[2].replace(/&amp;/g, '&');
  const els = { 'atb-host': el(dataAttrs), 'atb-frame': html.includes('<iframe') ? el() : null, 'atb-open': el(), 'atb-open-main': html.includes('atb-open-main') ? el() : null, 'atb-mixed': el(), footer: null };
  const sandbox = {
    window: { appTabs: core, innerHeight: 900, addEventListener() {} },
    document: { getElementById: (id) => els[id] || null, documentElement: { scrollHeight: 800 } },
    location: { protocol, hostname },
    getComputedStyle: () => ({ position: 'static' }),
    setTimeout: () => 0,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const before = new Set(Object.getOwnPropertyNames(sandbox));
  vm.runInContext(scripts[0], sandbox);
  const leaked = Object.getOwnPropertyNames(sandbox).filter((k) => !before.has(k));
  return { els, leaked, sandbox };
}

const base = { label: 'Backrest', url: 'http://[HOST]:9898/', open: 'iframe', enabled: true };

t('iframe tab: [HOST] resolves to the GUI hostname', () => {
  const r = run(render([base], 'Backrest'), { hostname: '192.168.0.10' });
  assert.strictEqual(r.els['atb-frame'].src, 'http://192.168.0.10:9898/');
  assert.strictEqual(r.els['atb-open'].href, 'http://192.168.0.10:9898/');
  assert.strictEqual(r.els["atb-mixed"].hidden, false);
});
t('iframe tab: follows whatever name the GUI was opened with', () => {
  const r = run(render([base], 'Backrest'), { hostname: 'unraid.lan' });
  assert.strictEqual(r.els['atb-frame'].src, 'http://unraid.lan:9898/');
});
t('IPv6 GUI host keeps its brackets', () => {
  const r = run(render([base], 'Backrest'), { hostname: '[fd00::1]' });
  assert.strictEqual(r.els['atb-frame'].src, 'http://[fd00::1]:9898/');
});
t('https GUI + http app: the frame stays empty and is hidden, the message shows, "Open full page" still works', () => {
  const r = run(render([base], 'Backrest'), { protocol: 'https:', hostname: 'nas' });
  assert.strictEqual(r.els['atb-frame'].src, '');
  assert.strictEqual(r.els['atb-frame'].hidden, true);
  assert.strictEqual(r.els['atb-mixed'].hidden, false);
  assert.strictEqual(r.els['atb-open'].href, 'http://nas:9898/');
});
t('https GUI + https app: embeds normally', () => {
  const r = run(render([{ ...base, url: 'https://[HOST]/x' }], 'Backrest'), { protocol: 'https:', hostname: 'nas' });
  assert.strictEqual(r.els['atb-frame'].src, 'https://nas/x');
});
t('new-tab mode: the landing link gets the resolved URL and there is no frame', () => {
  const r = run(render([{ ...base, open: 'newtab', url: 'https://example.com/a?b=1&c=2' }], 'Backrest'));
  assert.strictEqual(r.els['atb-open-main'].href, 'https://example.com/a?b=1&c=2');
  assert.strictEqual(r.els['atb-frame'], null);
});
t('no global leaks from the tab page script', () => {
  const r = run(render([base], 'Backrest'));
  assert.deepStrictEqual(r.leaked, []);
});
t('missing core: says so instead of throwing', () => {
  const html = render([base], 'Backrest');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const els = { 'atb-host': el({ 'data-url': 'http://x/' }), 'atb-frame': el(), 'atb-open': el(), 'atb-open-main': null };
  const sb = { window: {}, document: { getElementById: (id) => els[id] || null }, location: { protocol: 'http:', hostname: 'h' } };
  vm.createContext(sb);
  vm.runInContext(scripts[0], sb);
  assert.ok(/could not load/.test(els['atb-host'].text));
});
t('the core is the only script src, and it is a plugin-local path', () => {
  const html = render([base], 'Backrest');
  assert.deepStrictEqual([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]), ['/plugins/app.tabs/app-tabs-core.js']);
});
t('core exposes only window.appTabs in a browser-like scope', () => {
  const sb = { self: {} };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin/app-tabs-core.js'), 'utf8'), sb);
  assert.deepStrictEqual(Object.keys(sb.self), ['appTabs']);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(n + ' global-scope / page-script checks passed' + (process.exitCode ? ' (with failures above)' : ''));
