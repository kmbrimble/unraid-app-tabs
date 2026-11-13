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

console.log(n + ' JS checks passed' + (process.exitCode ? ' (with failures above)' : ''));
t('validateTabs: a label named like an Object.prototype member is not a false duplicate', () => {
  assert.deepStrictEqual(core.validateTabs([tab({ label: 'constructor' }), tab({ label: 'toString' })]), []);
  assert.ok(core.validateTabs([tab({ label: 'constructor' }), tab({ label: 'Constructor' })]).length > 0);
});
console.log('(constructor/duplicate check done)');
