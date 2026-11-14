'use strict';
// Unit tests for plugin/app-tabs-core.js, driven by the same vectors the PHP suite uses (tests/vectors.json).
const assert = require('assert');
const core = require('../plugin/app-tabs-core.js');
const v = require('./vectors.json');
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; } }

v.labels_ok.forEach((l) => t('label ok: ' + JSON.stringify(l), () => assert.strictEqual(core.validateLabel(l), null)));
v.labels_bad.forEach((l) => t('label bad: ' + JSON.stringify(l), () => assert.notStrictEqual(core.validateLabel(l), null)));
Object.keys(v.slugs).forEach((k) => t('slug ' + k, () => assert.strictEqual(core.slugOf(k), v.slugs[k])));
v.urls_ok.forEach((u) => t('url ok: ' + JSON.stringify(u), () => assert.strictEqual(core.validateUrl(u), null)));
v.urls_bad.forEach((u) => t('url bad: ' + JSON.stringify(u), () => assert.notStrictEqual(core.validateUrl(u), null)));
v.resolve.forEach(([u, h, want]) => t('resolve ' + u + ' @ ' + h, () => assert.strictEqual(core.resolveUrl(u, h), want)));

v.identifiers_ok.forEach((x) => t('identifier ok: ' + JSON.stringify(x).slice(0, 40), () => { assert.strictEqual(core.validateContainer(x), null); assert.strictEqual(core.validateSession(x), null); }));
v.identifiers_bad.forEach((x) => t('identifier bad: ' + JSON.stringify(x).slice(0, 40), () => { assert.notStrictEqual(core.validateContainer(x), null); if (x !== '') assert.notStrictEqual(core.validateSession(x), null); }));
t('container: required; session: optional', () => { assert.notStrictEqual(core.validateContainer(''), null); assert.strictEqual(core.validateSession(''), null); });
t('container/session: non-strings refused (session null/undefined handled by validateTabs)', () => { [null, undefined, 5, {}, ['a']].forEach((x) => { assert.notStrictEqual(core.validateContainer(x), null); assert.notStrictEqual(core.validateSession(x), null); }); });
v.shells_ok.forEach((x) => t('shell ok: ' + x, () => assert.strictEqual(core.validateShell(x), null)));
v.shells_bad.forEach((x) => t('shell bad: ' + JSON.stringify(x), () => assert.notStrictEqual(core.validateShell(x), null)));

t('mixed content: https GUI + http app', () => assert.strictEqual(core.isMixedContent('https:', 'http://x/'), true));
t('mixed content: https GUI + https app', () => assert.strictEqual(core.isMixedContent('https:', 'https://x/'), false));
t('mixed content: http GUI + http app', () => assert.strictEqual(core.isMixedContent('http:', 'http://x/'), false));

const tab = (o) => Object.assign({ label: 'Backrest', url: 'http://[HOST]:9898/', open: 'iframe', enabled: true }, o || {});
t('validateTabs: a good list', () => assert.deepStrictEqual(core.validateTabs([tab(), tab({ label: 'Other' })]), []));
t('validateTabs: duplicate labels (case-insensitive, via slug)', () => assert.ok(core.validateTabs([tab(), tab({ label: 'backrest' })]).some((e) => e.field === 'label' && e.index === 1)));
t('validateTabs: "My App" and "My-App" collide on file name', () => assert.ok(core.validateTabs([tab({ label: 'My App' }), tab({ label: 'My-App' })]).length > 0));
t('validateTabs: bad open and enabled', () => {
  const f = core.validateTabs([tab({ open: 'frame', enabled: 'yes' })]).map((e) => e.field).sort();
  assert.deepStrictEqual(f, ['enabled', 'open']);
});
t('validateTabs: too many', () => assert.ok(core.validateTabs(Array.from({ length: core.MAX_TABS + 1 }, (_, i) => tab({ label: 'T' + i }))).some((e) => e.index === -1)));
t('validateTabs: not a list', () => assert.ok(core.validateTabs({}).length === 1));

const ctab = (o) => Object.assign({ label: 'Claude', kind: 'console', container: 'claude-code', session: 'claude', shell: 'sh', enabled: true }, o || {});
t('validateTabs: a console tab is valid', () => assert.deepStrictEqual(core.validateTabs([tab(), ctab()]), []));
t('validateTabs: a console tab needs no url/open, and a legacy tab needs no kind', () => assert.deepStrictEqual(core.validateTabs([{ label: 'A', container: 'c', enabled: true, kind: 'console' }, tab({ kind: undefined })]), []));
t('validateTabs: null kind/session/shell behave like absent (PHP parity)', () => assert.deepStrictEqual(core.validateTabs([ctab({ session: null, shell: null }), tab({ label: 'B', kind: null })]), []));
[['container', { container: 'a;b' }], ['container', { container: '' }], ['session', { session: '$(x)' }], ['session', { session: '-t' }], ['shell', { shell: 'zsh' }], ['kind', { kind: 'terminal' }]].forEach(([field, o]) =>
  t('validateTabs: bad console ' + field + ' ' + JSON.stringify(o), () => assert.ok(core.validateTabs([ctab(o)]).some((e) => e.field === field && e.index === 0))));
t('validateTabs: console and URL tabs share the label namespace', () => assert.ok(core.validateTabs([tab({ label: 'Claude' }), ctab()]).some((e) => e.field === 'label' && e.index === 1)));
t('validateTabs: console tabs count toward the limit', () => assert.ok(core.validateTabs(Array.from({ length: core.MAX_TABS + 1 }, (_, i) => ctab({ label: 'C' + i }))).some((e) => e.index === -1)));
console.log(n + ' JS checks passed' + (process.exitCode ? ' (with failures above)' : ''));
t('validateTabs: a label named like an Object.prototype member is not a false duplicate', () => {
  assert.deepStrictEqual(core.validateTabs([tab({ label: 'constructor' }), tab({ label: 'toString' })]), []);
  assert.ok(core.validateTabs([tab({ label: 'constructor' }), tab({ label: 'Constructor' })]).length > 0);
});
console.log('(constructor/duplicate check done)');
