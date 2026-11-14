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

// ---- console tabs: real PHP render against the stand-in docker / ttyd-exec (tests/stubs), then the page script in a vm ----
const stubDir = path.join(dir, 'stub'); const socks = path.join(dir, 'socks');
fs.mkdirSync(stubDir); fs.mkdirSync(socks);
const stubs = path.join(__dirname, 'stubs');
const stubEnv = () => ({ PATH: process.env.PATH, APPTABS_CONFIG_DIR: dir + '/cfg', APPTABS_PAGES_DIR: dir + '/pages', APPTABS_STUB_DIR: stubDir, APPTABS_DOCKER: stubs + '/docker', APPTABS_TTYD_EXEC: stubs + '/ttyd-exec', APPTABS_SOCK_DIR: socks });
function renderConsole(tab, slug, env) {
  fs.writeFileSync(dir + '/cfg/tabs.json', JSON.stringify({ version: 2, tabs: [tab] }));
  return execFileSync('php', [path.join(__dirname, 'render-tab.php'), slug], { env: Object.assign(stubEnv(), env || {}) }).toString();
}
function reap() { execFileSync('php', [path.join(__dirname, '..', 'plugin', 'include', 'console-stop.php')], { env: stubEnv() }); }
function consoleEl(attrs) {
  const e = el(attrs); e.listeners = {};
  e.addEventListener = (ev, fn) => { e.listeners[ev] = fn; };
  e.contentWindow = { focused: 0, focus() { this.focused++; } };
  return e;
}
function runConsole(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 1, 'exactly one inline script');
  const frame = consoleEl({ src: (html.match(/<iframe[^>]* src="([^"]*)"/) || [])[1] });
  const reconnect = consoleEl(); const footer = null; let winL = {};
  const sandbox = {
    window: { innerHeight: 900, addEventListener(ev, fn) { winL[ev] = fn; } },
    document: { getElementById: (id) => ({ 'atb-frame': frame, 'atb-reconnect': reconnect }[id] || footer), documentElement: { scrollHeight: 800 } },
    getComputedStyle: () => ({ position: 'static' }), setTimeout: () => 0,
    location: { reload() { reloaded++; } },
  };
  let reloaded = 0;
  vm.createContext(sandbox);
  const before = new Set(Object.getOwnPropertyNames(sandbox));
  vm.runInContext(scripts[0], sandbox);
  return { reloads: () => reloaded, frame, reconnect, winL, leaked: Object.getOwnPropertyNames(sandbox).filter((k) => !before.has(k)) };
}
const ctabPage = { label: 'Claude', kind: 'console', container: 'claude-code', session: 'claude', shell: 'sh', enabled: true };
fs.writeFileSync(stubDir + '/ps.txt', 'claude-code|running\nstopped-one|exited\n');
fs.writeFileSync(stubDir + '/sessions.txt', 'claude\n');
t('console tab: the iframe points at the relative /logterminal/ socket URL of this tab, server-side, with no URL-tab machinery', () => {
  const html = renderConsole(ctabPage, 'Claude');
  assert.ok(html.includes('<iframe id="atb-frame" title="Claude console" src="/logterminal/_apptabs-Claude/"></iframe>'), html);
  assert.ok(!html.includes('data-url') && !html.includes('atb-mixed') && !html.includes('app-tabs-core.js'));
  assert.ok(html.includes('href="/logterminal/_apptabs-Claude/" target="_blank"'));
});
t('console tab: the page names no container or session (only the whitelisted label reaches HTML)', () => {
  const html = renderConsole(ctabPage, 'Claude');
  assert.ok(!html.includes('claude-code') && !/tmux/.test(html));
});
t('console tab: the page script focuses the terminal on load, refits on resize, and Reconnect reloads the page; no leaks', () => {
  const r = runConsole(renderConsole(ctabPage, 'Claude'));
  assert.deepStrictEqual(r.leaked, []);
  assert.ok(r.winL.resize && r.winL.load);
  r.frame.listeners.load();
  assert.strictEqual(r.frame.contentWindow.focused, 1);
  let prevented = 0;
  r.reconnect.listeners.click({ preventDefault() { prevented++; } });
  assert.strictEqual(prevented, 1); assert.strictEqual(r.reloads(), 1, 'Reconnect reloads the page, so the container/ttyd checks run again');
  assert.ok(parseInt(r.frame.style.height, 10) >= 320);
});
t('console tab: a cross-origin or failing contentWindow.focus() does not throw', () => {
  const r = runConsole(renderConsole(ctabPage, 'Claude'));
  r.frame.contentWindow.focus = () => { throw new Error('denied'); };
  r.frame.listeners.load();
});
for (const [why, tabv, needle] of [
  ['missing container', { ...ctabPage, container: 'ghost-box' }, 'There is no Docker container named ghost-box'],
  ['stopped container', { ...ctabPage, container: 'stopped-one' }, 'is not running'],
  ['missing tmux session', { ...ctabPage, session: 'nosuch' }, 'no tmux session named nosuch'],
]) {
  t('console tab: ' + why + ' shows a message, not an iframe or script', () => {
    const html = renderConsole(tabv, 'Claude');
    assert.ok(html.includes('role="alert"') && html.includes(needle), html);
    assert.ok(!html.includes('<iframe') && !html.includes('<script'));
    assert.ok(html.includes('Try again'));
  });
}
t('console tab: docker missing and hung-ttyd messages are shown', () => {
  assert.ok(renderConsole(ctabPage, 'Claude', { APPTABS_DOCKER: dir + '/nope' }).includes('docker command was not found'));
  assert.ok(renderConsole(ctabPage, 'Claude', { APPTABS_TTYD_EXEC: dir + '/nope' }).includes('ttyd-exec'));
});
t('console tab: messages are HTML-escaped (a hostile Docker error cannot inject markup)', () => {
  fs.writeFileSync(dir + '/evil-docker', '#!/bin/bash\necho "<script>alert(1)</script>" >&2\nexit 1\n', { mode: 0o755 });
  const html = renderConsole(ctabPage, 'Claude', { APPTABS_DOCKER: dir + '/evil-docker' });
  assert.ok(html.includes('role="alert"') && !html.includes('<script>alert(1)'), html);
});
t('console tab: a disabled tab renders the not-configured message and calls nothing', () => {
  const lines = () => (fs.existsSync(stubDir + '/docker.log') ? fs.readFileSync(stubDir + '/docker.log', 'utf8').split('\n').length : 0);
  const before = lines();
  const html = renderConsole({ ...ctabPage, enabled: false }, 'Claude');
  assert.ok(html.includes('no longer configured') && !html.includes('<iframe'));
  assert.strictEqual(lines(), before, 'a disabled tab must not call docker');
});
reap();
fs.rmSync(dir, { recursive: true, force: true });
console.log(n + ' global-scope / page-script checks passed' + (process.exitCode ? ' (with failures above)' : ''));
