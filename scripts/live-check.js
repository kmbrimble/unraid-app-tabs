#!/usr/bin/env node
// Headless-Chromium live checks of App Tabs on the Unraid host. Not shipped in the txz.
//   NODE_PATH=<dir with node_modules/playwright-core> node scripts/live-check.js <mode> [outDir]
// Modes:
//   shots     settings + Backrest tab, dark and light, 1920 and 375; reports errors, scroll, top bar text; saves PNGs
//   exercise  add / edit / reorder / disable / delete a throwaway tab ("ZzTest") and confirm its .page appears and
//             disappears over SSH and that the top bar follows
//   pages     loads stock pages (Main, Docker, Dashboard, SecretsMan, NetMan) and reports errors
// Env: UNRAID_HOST (default 192.168.0.10), UNRAID_SSH_KEY (default /root/.ssh/unraid_secretsman).
// Auth: reuses the newest active root PHP session on the host as cookie unraid_<md5(host)>. The id is never printed.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const HOST = process.env.UNRAID_HOST || '192.168.0.10';
const KEY = process.env.UNRAID_SSH_KEY || '/root/.ssh/unraid_secretsman';
const mode = process.argv[2];
const OUT = process.argv[3] || '/tmp/apptabs-shots';
const PLUGIN = '/usr/local/emhttp/plugins/app.tabs';
const ssh = (cmd) => execFileSync('ssh', ['-o', 'StrictHostKeyChecking=no', '-i', KEY, `root@${HOST}`, cmd]).toString();

function sessionId() {
  const out = ssh('for f in $(ls -t /var/lib/php/sess_*); do grep -q "unraid_user|s:4:\\"root\\"" $f && { echo ${f##*sess_}; break; }; done').trim();
  if (!out) throw new Error('no active root session found on host');
  return out;
}
function headlessShell() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dir = fs.readdirSync(base).find((d) => d.startsWith('chromium_headless_shell-'));
  const found = execFileSync('find', [path.join(base, dir), '-name', 'chrome-headless-shell', '-type', 'f']).toString().split('\n')[0];
  if (!found) throw new Error('chrome-headless-shell not found');
  return found;
}

let bad = 0;
const fail = (msg) => { bad++; console.log('FAIL ' + msg); };
const ok = (msg) => console.log('ok   ' + msg);
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));

async function newCtx(browser, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addCookies([{ name: 'unraid_' + crypto.createHash('md5').update(HOST).digest('hex'), value: sessionId(), domain: HOST, path: '/' }]);
  return ctx;
}
function watch(page, errors) {
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('framenavigated', () => {});
}
const topBar = (page) => page.$$eval('#menu .nav-tile:not(.right) .nav-item a', (as) => as.map((a) => a.textContent.trim().toUpperCase()));
const scrollInfo = (page) => page.evaluate(() => ({ h: document.documentElement.scrollWidth > window.innerWidth, v: document.documentElement.scrollHeight > window.innerHeight + 2 }));
async function setTheme(page, theme) { // the in-app switch, inside the iframe
  const f = page.frameLocator('#atb-set-frame');
  await f.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
}
async function gotoSettings(page) {
  await page.goto(`http://${HOST}:81/Settings/AppTabs`, { waitUntil: 'load', timeout: 60000 });
  await page.frameLocator('#atb-set-frame').getByRole('heading', { name: 'App Tabs' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
}

async function shots(browser) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [w, h] of [[1920, 1012], [375, 812]]) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newCtx(browser, w, h);
      const errors = [];
      const page = await ctx.newPage(); watch(page, errors);
      await gotoSettings(page);
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      let sc = await scrollInfo(page);
      expect(!sc.h && !sc.v, `settings ${theme} ${w}: no page scroll (h=${sc.h} v=${sc.v})`);
      await page.screenshot({ path: `${OUT}/apptabs-settings-${theme}-${w}.png` });
      const frame = page.frames().find((f) => f.url().includes('/app/index.php'));
      const fs2 = await frame.evaluate(() => ({ h: document.documentElement.scrollWidth > window.innerWidth }));
      expect(!fs2.h, `settings ${theme} ${w}: no horizontal scroll inside the app`);
      await page.goto(`http://${HOST}:81/AppTab-Backrest`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(3500);
      sc = await scrollInfo(page);
      expect(!sc.h && !sc.v, `backrest tab ${theme} ${w}: no page scroll (h=${sc.h} v=${sc.v})`);
      const bar = await topBar(page);
      if (w === 1920 && theme === 'dark') console.log('     top bar: ' + bar.join(', '));
      await page.screenshot({ path: `${OUT}/apptabs-backrest-${theme}-${w}.png` });
      expect(errors.length === 0, `errors ${theme} ${w}: ${errors.join(' | ') || 'none'}`);
      await ctx.close();
    }
  }
}

async function exercise(browser) {
  const ctx = await newCtx(browser, 1920, 1012);
  const errors = [];
  const page = await ctx.newPage(); watch(page, errors);
  const pageFiles = () => ssh(`ls ${PLUGIN} | grep '^AppTab-' | sort | tr '\\n' ' '`).trim();
  const rankOf = (f) => ssh(`grep -m1 '^Menu=' ${PLUGIN}/${f}.page`).trim();
  const f = () => page.frameLocator('#atb-set-frame');
  console.log('     start pages: ' + pageFiles());
  await gotoSettings(page);

  await f().getByRole('button', { name: 'Add tab' }).click();
  await f().locator('#atb-f-label').fill('ZzTest');
  await f().locator('#atb-f-url').fill('http://[HOST]:81/Dashboard');
  await f().getByRole('button', { name: 'Save', exact: true }).click();
  await f().getByText('Added ZzTest.').waitFor();
  expect(/AppTab-ZzTest/.test(pageFiles()), 'add: AppTab-ZzTest.page exists on the host');
  console.log('     ' + rankOf('AppTab-ZzTest'));
  await page.goto(`http://${HOST}:81/Main`, { waitUntil: 'load' });
  let bar = await topBar(page);
  expect(bar.includes('ZZTEST'), 'add: top bar now ' + bar.join(', '));
  await page.goto(`http://${HOST}:81/AppTab-ZzTest`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const inner = page.frames().find((fr) => fr.url().includes(':81/Dashboard'));
  expect(!!inner, 'tab iframe loaded http://' + HOST + ':81/Dashboard (the [HOST] placeholder resolved)');

  await gotoSettings(page);
  await f().getByRole('button', { name: 'Edit ZzTest' }).click();
  await f().locator('#atb-f-url').fill('http://[HOST]:81/Main');
  await f().getByRole('button', { name: 'Save', exact: true }).click();
  await f().getByText('Saved ZzTest.').waitFor();
  const cfg = ssh('cat /boot/config/plugins/app.tabs/tabs.json');
  expect(cfg.includes('http://[HOST]:81/Main'), 'edit: tabs.json on flash has the new URL');

  const before = rankOf('AppTab-ZzTest');
  await f().getByRole('button', { name: 'Move ZzTest up' }).click();
  await f().getByText('Moved ZzTest up.').waitFor();
  expect(rankOf('AppTab-ZzTest') !== before, `reorder: ranks changed (${before} -> ${rankOf('AppTab-ZzTest')})`);
  await page.goto(`http://${HOST}:81/Main`, { waitUntil: 'load' });
  bar = await topBar(page);
  expect(bar.indexOf('ZZTEST') < bar.indexOf('BACKREST'), 'reorder: top bar ' + bar.join(', '));
  await gotoSettings(page);
  await f().getByRole('button', { name: 'Move ZzTest down' }).click();
  await f().getByText('Moved ZzTest down.').waitFor();

  await f().locator('.atb-row', { hasText: 'ZzTest' }).locator('input[type=checkbox]').uncheck();
  await f().getByText('Disabled ZzTest.').waitFor();
  expect(!/AppTab-ZzTest/.test(pageFiles()), 'disable: page removed');
  await page.goto(`http://${HOST}:81/Main`, { waitUntil: 'load' });
  expect(!(await topBar(page)).includes('ZZTEST'), 'disable: top bar no longer has ZzTest');
  await gotoSettings(page);
  await f().locator('.atb-row', { hasText: 'ZzTest' }).locator('input[type=checkbox]').check();
  await f().getByText('Enabled ZzTest.').waitFor();
  expect(/AppTab-ZzTest/.test(pageFiles()), 'enable: page is back');

  await f().getByRole('button', { name: 'Delete ZzTest' }).click();
  await f().getByRole('button', { name: 'Delete', exact: true }).click();
  await f().getByText('Deleted ZzTest.').waitFor();
  expect(!/AppTab-ZzTest/.test(pageFiles()), 'delete: page removed');
  expect(!ssh('cat /boot/config/plugins/app.tabs/tabs.json').includes('ZzTest'), 'delete: gone from tabs.json');
  console.log('     end pages: ' + pageFiles());
  expect(errors.length === 0, 'errors: ' + (errors.join(' | ') || 'none'));
  await ctx.close();
}

async function pages(browser) {
  const ctx = await newCtx(browser, 1920, 1012);
  for (const p of ['/Main', '/Docker', '/Dashboard', '/SecretsMan', '/DockerNetMan', '/Settings/AppTabs', '/AppTab-Backrest']) {
    const errors = [];
    const page = await ctx.newPage(); watch(page, errors);
    await page.goto(`http://${HOST}:81${p}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2500);
    const bar = await topBar(page);
    expect(errors.length === 0, `${p}: ${errors.join(' | ') || 'no page/console errors'}  [top bar ${bar.join(', ')}]`);
    await page.close();
  }
  await ctx.close();
}

(async () => {
  if (!['shots', 'exercise', 'pages'].includes(mode)) { console.error('usage: live-check.js shots|exercise|pages [outDir]'); process.exit(2); }
  const browser = await chromium.launch({ executablePath: headlessShell() });
  try { await { shots, exercise, pages }[mode](browser); } finally { await browser.close(); }
  console.log(bad ? `${bad} FAILED` : 'all ok');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
