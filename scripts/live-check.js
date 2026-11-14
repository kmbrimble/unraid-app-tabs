#!/usr/bin/env node
// Headless-Chromium live checks of App Tabs on the Unraid host. Not shipped in the txz.
//   NODE_PATH=<dir with node_modules/playwright-core> node scripts/live-check.js <mode> [outDir]
// Modes:
//   shots     settings + Backrest tab, dark and light, 1920 and 375; reports errors, scroll, top bar text; saves PNGs
//   exercise  add / edit / reorder / disable / delete a throwaway tab ("ZzTest") and confirm its .page appears and
//             disappears over SSH and that the top bar follows
//   setup     creates the Backrest tab (http://[HOST]:9898/, in a tab, enabled) through the settings UI
//   console-setup   adds the throwaway console tabs (ZzConsole -> tmux session apptabs-test, ZzGhost -> a container that does not exist)
//                   through the settings UI. Needs: docker exec claude-code tmux new -d -s apptabs-test
//   console-test    functional checks on ZzConsole/ZzGhost (types ONLY into apptabs-test, never into a real session)
//   console-clean   deletes the throwaway tabs through the UI and checks their ttyd goes with them
//   console-real    attaches the Claude tab to the real session with ZERO input (screenshot only), then disconnects
//   pages     loads stock pages (Main, Docker, Dashboard, SecretsMan, NetMan) and reports errors
// Env: UNRAID_HOST (default 192.168.0.10), UNRAID_SSH_KEY (default /root/.ssh/unraid_secretsman).
// Auth: reuses the newest active root PHP session on the host as cookie unraid_<md5(host)>. The id is never printed.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');

const HOST = process.env.UNRAID_HOST || '192.168.0.10';
const KEY = process.env.UNRAID_SSH_KEY || '/root/.ssh/unraid_secretsman';
const mode = process.argv[2];
const OUT = process.argv[3] || '/tmp/apptabs-shots';
require('fs').mkdirSync(OUT, { recursive: true });
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
  if (await f().getByRole('button', { name: 'Delete ZzTest' }).count()) { // a leftover from an interrupted run
    await f().getByRole('button', { name: 'Delete ZzTest' }).click();
    await f().getByRole('button', { name: 'Delete', exact: true }).click();
    await f().getByText('Deleted ZzTest.').waitFor();
  }

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

  await f().locator('.atb-row', { hasText: 'ZzTest' }).locator('input[type=checkbox]').click(); // controlled input: it flips only after the server confirms, so click and wait for the toast
  await f().getByText('Disabled ZzTest.').waitFor();
  expect(!/AppTab-ZzTest/.test(pageFiles()), 'disable: page removed');
  await page.goto(`http://${HOST}:81/Main`, { waitUntil: 'load' });
  expect(!(await topBar(page)).includes('ZZTEST'), 'disable: top bar no longer has ZzTest');
  await gotoSettings(page);
  await f().locator('.atb-row', { hasText: 'ZzTest' }).locator('input[type=checkbox]').click();
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

async function setup(browser) {
  const ctx = await newCtx(browser, 1920, 1012);
  const errors = [];
  const page = await ctx.newPage(); watch(page, errors);
  const f = () => page.frameLocator('#atb-set-frame');
  await gotoSettings(page);
  await f().getByRole('button', { name: 'Add tab' }).click();
  await f().locator('#atb-f-label').fill('Backrest');
  await f().locator('#atb-f-url').fill('http://[HOST]:9898/');
  await f().getByRole('button', { name: 'Save', exact: true }).click();
  await f().getByText('Added Backrest.').waitFor();
  expect(ssh('cat /boot/config/plugins/app.tabs/tabs.json').includes('http://[HOST]:9898/'), 'tabs.json on flash has Backrest');
  expect(errors.length === 0, 'errors: ' + (errors.join(' | ') || 'none'));
  await ctx.close();
}

// ---- Docker console tabs ----------------------------------------------------------------------------------------------------
const TEST_SESSION = 'apptabs-test';
const CONTAINER = 'claude-code';
const SOCK = (label) => `/logterminal/_apptabs-${label}/`;
const cookieHeader = () => `unraid_${crypto.createHash('md5').update(HOST).digest('hex')}=${sessionId()}`;
const ttyds = () => ssh('pgrep -ax ttyd || true').trim().split('\n').filter(Boolean);
const apptabsTtyds = (label = 'ZzConsole') => ttyds().filter((l) => l.includes(`_apptabs-${label}.sock`));
// host-side console processes besides ttyd itself (anchored: a pattern in a remote shell's own command line must not match)
const strays = () => ssh("pgrep -af '^(/usr/bin/)?bash /usr/local/emhttp/plugins/app.tabs/scripts/console-attach.sh|^(/usr/bin/)?docker exec -it' || true").trim().split('\n').filter(Boolean);
const tmuxClients = (session) => ssh(`docker exec ${CONTAINER} tmux list-clients -t =${session} -F '#{client_width}x#{client_height}' 2>/dev/null || true`).trim().split('\n').filter(Boolean);
function rawGet(path, headers) { // no cookie unless given; returns {status, headers, body (first 300 bytes)}
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: 81, path, method: 'GET', headers: headers || {} }, (res) => {
      let b = ''; res.on('data', (d) => { if (b.length < 300) b += d; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: b }));
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('timeout'))); req.end();
  });
}
function rawUpgrade(path, headers) { // a websocket upgrade attempt; resolves with the status line only, then drops the connection
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: 81, path, method: 'GET', headers: Object.assign({ Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': 'tty' }, headers || {}) });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('timeout'))); req.end();
  });
}
async function addTab(page, fields) {
  const f = () => page.frameLocator('#atb-set-frame');
  await f().getByRole('button', { name: 'Add tab' }).click();
  await f().locator('#atb-f-label').fill(fields.label);
  await f().locator('#atb-f-kind').selectOption('console');
  await f().locator('#atb-f-container').fill(fields.container);
  await f().locator('#atb-f-session').fill(fields.session);
  await f().getByRole('button', { name: 'Save', exact: true }).click();
  await f().getByText(`Added ${fields.label}.`).waitFor({ timeout: 20000 });
}
async function deleteTab(page, label) {
  const f = () => page.frameLocator('#atb-set-frame');
  if (!(await f().getByRole('button', { name: `Delete ${label}` }).count())) return false;
  await f().getByRole('button', { name: `Delete ${label}` }).click();
  await f().getByRole('button', { name: 'Delete', exact: true }).click();
  await f().getByText(`Deleted ${label}.`).waitFor({ timeout: 20000 });
  return true;
}
const hasTab = async (page, label) => (await page.frameLocator('#atb-set-frame').getByRole('button', { name: `Delete ${label}` }).count()) > 0;

async function consoleSetup(browser) {
  const ctx = await newCtx(browser, 1920, 1012);
  const errors = []; const page = await ctx.newPage(); watch(page, errors);
  await gotoSettings(page);
  expect(ssh(`docker exec ${CONTAINER} tmux has-session -t =${TEST_SESSION} && echo yes`).trim() === 'yes', `throwaway tmux session ${TEST_SESSION} exists`);
  if (!(await hasTab(page, 'ZzConsole'))) await addTab(page, { label: 'ZzConsole', container: CONTAINER, session: TEST_SESSION });
  if (!(await hasTab(page, 'ZzGhost'))) await addTab(page, { label: 'ZzGhost', container: 'no-such-box-xyz', session: 'x' });
  const cfg = JSON.parse(ssh('cat /boot/config/plugins/app.tabs/tabs.json'));
  expect(cfg.version === 2 && cfg.tabs.some((t) => t.kind === 'console' && t.label === 'ZzConsole' && t.session === TEST_SESSION), 'tabs.json is version 2 and holds the console tab');
  expect(cfg.tabs[0].label === 'Backrest' && cfg.tabs[0].kind === 'url' && cfg.tabs[0].url === 'http://[HOST]:9898/', 'Backrest is unchanged (now with an explicit kind)');
  console.log('     pages: ' + ssh(`ls ${PLUGIN} | grep '^AppTab-' | tr '\n' ' '`).trim());
  expect(errors.length === 0, 'errors: ' + (errors.join(' | ') || 'none'));
  await ctx.close();
}

async function consoleTest(browser) {
  const base = ttyds();
  console.log('     ttyd before (pgrep -ax ttyd): ' + (base.length ? base.map((l) => l.slice(0, 110)).join(' || ') : 'none'));
  const ctx = await newCtx(browser, 1920, 1012);

  // 1. unauthenticated access to the proxied socket is refused. The ttyd must actually be listening first.
  let errors = [];
  const page = await ctx.newPage(); watch(page, errors);
  const wsFrames = []; const wsOpened = [];
  page.on('websocket', (ws) => { wsOpened.push(ws.url()); ws.on('framereceived', (e) => wsFrames.push(typeof e.payload === 'string' ? e.payload : Buffer.from(e.payload).toString('latin1'))); });
  await page.goto(`http://${HOST}:81/AppTab-ZzConsole`, { waitUntil: 'load', timeout: 60000 });
  const frameEl = page.locator('#atb-frame');
  await frameEl.waitFor({ timeout: 15000 });
  expect((await frameEl.getAttribute('src')) === SOCK('ZzConsole'), 'iframe src is the relative ' + SOCK('ZzConsole'));
  const p0 = apptabsTtyds();
  expect(p0.length === 1, 'exactly one console ttyd after the first load: ' + p0.map((l) => l.replace(/^\d+ /, '').slice(0, 200)).join(' || '));
  console.log('     ttyd argv: ' + (p0[0] || '').replace(/-t theme=\S+/, '').slice(0, 330));
  expect(!/(^| )-c |--credential|token|passw|secret/i.test(p0[0] || ''), 'no credential option or secret-looking word in the ttyd argv');
  const un = [['/', SOCK('ZzConsole')], ['/token', SOCK('ZzConsole') + 'token'], ['/index', SOCK('ZzConsole') + 'x']];
  for (const [n, p] of un) {
    const r = await rawGet(p);
    expect(r.status !== 200 && !/ttyd|xterm/i.test(r.body), `unauthenticated GET ${n === '/' ? 'socket root' : n} refused: HTTP ${r.status}${r.location ? ' -> ' + r.location : ''}`);
  }
  const bad = await rawGet(SOCK('ZzConsole'), { Cookie: 'unraid_' + crypto.createHash('md5').update(HOST).digest('hex') + '=notasession' });
  expect(bad.status !== 200 && !/ttyd|xterm/i.test(bad.body), `GET with a bogus session cookie refused: HTTP ${bad.status}`);
  const uw = await rawUpgrade(SOCK('ZzConsole') + 'ws');
  expect(uw.status !== 101, `unauthenticated websocket upgrade refused: HTTP ${uw.status}`);
  const aw = await rawGet(SOCK('ZzConsole'), { Cookie: cookieHeader() });
  expect(aw.status === 200 && /<html/i.test(aw.body), `contrast: the same GET with the GUI session is served: HTTP ${aw.status}`);
  const au = await rawUpgrade(SOCK('ZzConsole') + 'ws', { Cookie: cookieHeader() });
  expect(au.status === 101, `contrast: authenticated websocket upgrade: HTTP ${au.status}`);
  await new Promise((r) => setTimeout(r, 1500));

  // 2. the iframe receives terminal output over the websocket
  const inner = page.frames().find((f) => f.url().includes('/logterminal/'));
  expect(!!inner, 'terminal frame exists');
  await page.waitForFunction(() => true);
  const t0 = Date.now();
  while (Date.now() - t0 < 10000 && !wsFrames.some((f) => f.length > 20)) await new Promise((r) => setTimeout(r, 250));
  expect(wsOpened.some((u) => u.includes('/logterminal/_apptabs-ZzConsole/ws')), 'the iframe opened ' + wsOpened.filter((u) => u.includes('logterminal')).join(', '));
  expect(wsFrames.some((f) => f.length > 20), `terminal output received over the websocket (${wsFrames.length} frames, ${wsFrames.join('').length} bytes)`);
  expect(tmuxClients(TEST_SESSION).length >= 1, 'tmux sees an attached client in the container: ' + tmuxClients(TEST_SESSION).join(','));

  // 3. keyboard focus: clicking the terminal focuses it; typed text reaches the throwaway session only
  const box = await frameEl.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const focused = await inner.evaluate(() => document.activeElement && document.activeElement.className);
  expect(/xterm-helper-textarea/.test(String(focused)), 'clicking the terminal focuses the xterm input (activeElement class: ' + focused + ')');
  const seen = () => wsFrames.join('');
  await page.keyboard.type('echo APPTABS_$((6*7))');
  await page.keyboard.press('Enter');
  const t1 = Date.now();
  while (Date.now() - t1 < 8000 && !/APPTABS_42/.test(seen())) await new Promise((r) => setTimeout(r, 250));
  expect(/APPTABS_42/.test(seen()), 'typed input ran in the throwaway session and its output came back (APPTABS_42)');
  expect(ssh(`docker exec ${CONTAINER} tmux capture-pane -p -t =${TEST_SESSION}: | grep -c APPTABS_42`).trim() !== '0', 'and the pane of tmux session ' + TEST_SESSION + ' shows it');
  await page.screenshot({ path: `${OUT}/apptabs-console-1920.png` });

  // 4. resize: the pty follows the viewport
  const before = tmuxClients(TEST_SESSION)[0];
  await page.setViewportSize({ width: 1100, height: 700 });
  await new Promise((r) => setTimeout(r, 1500));
  const after = tmuxClients(TEST_SESSION)[0];
  expect(before && after && before !== after, `resize reached tmux: client ${before} -> ${after}`);
  await page.screenshot({ path: `${OUT}/apptabs-console-1100.png` });
  await page.setViewportSize({ width: 1920, height: 1012 });

  // 5. reload x5: still exactly one ttyd with the same pid; the old tmux clients are gone
  const pid0 = (p0[0] || '').split(' ')[0];
  for (let i = 0; i < 5; i++) { await page.reload({ waitUntil: 'load' }); await new Promise((r) => setTimeout(r, 700)); }
  await new Promise((r) => setTimeout(r, 2000));
  const p1 = apptabsTtyds();
  expect(p1.length === 1 && p1[0].split(' ')[0] === pid0, `after 5 reloads: ${p1.length} console ttyd, pid ${p1.map((l) => l.split(' ')[0]).join(',')} (was ${pid0})`);
  expect(tmuxClients(TEST_SESSION).length === 1, `after 5 reloads exactly one tmux client remains (${tmuxClients(TEST_SESSION).length}): no accumulation`);

  // 6. two page loads at the same instant
  const page2 = await ctx.newPage(); const e2 = []; watch(page2, e2);
  await Promise.all([page.goto(`http://${HOST}:81/AppTab-ZzConsole`, { waitUntil: 'load' }), page2.goto(`http://${HOST}:81/AppTab-ZzConsole`, { waitUntil: 'load' })]);
  await new Promise((r) => setTimeout(r, 2500));
  const p2 = apptabsTtyds();
  expect(p2.length === 1, `two simultaneous loads: ${p2.length} console ttyd`);
  expect(tmuxClients(TEST_SESSION).length === 2, `...both windows are attached (${tmuxClients(TEST_SESSION).length} tmux clients)`);
  expect(e2.length === 0, 'second page errors: ' + (e2.join(' | ') || 'none'));
  await page2.close();
  await new Promise((r) => setTimeout(r, 1500));
  expect(tmuxClients(TEST_SESSION).length === 1, `closing a page detaches its client in the container (${tmuxClients(TEST_SESSION).length} left)`);

  // 6b. Reconnect reloads the page: still one ttyd and one client, and a new websocket
  const wsBefore = wsOpened.length;
  await page.locator('#atb-reconnect').click();
  await page.waitForLoadState('load');
  await new Promise((r) => setTimeout(r, 2500));
  expect(wsOpened.length > wsBefore && apptabsTtyds().length === 1 && tmuxClients(TEST_SESSION).length === 1, `Reconnect: new websocket (${wsOpened.length - wsBefore}), ${apptabsTtyds().length} ttyd, ${tmuxClients(TEST_SESSION).length} tmux client`);

  // 7. stock pages start nothing
  const nBefore = apptabsTtyds().length;
  const stock = await ctx.newPage();
  for (const p of ['/Dashboard', '/Main']) await stock.goto(`http://${HOST}:81${p}`, { waitUntil: 'load', timeout: 60000 });
  await stock.close();
  expect(apptabsTtyds().length === nBefore, 'loading /Dashboard and /Main starts no console ttyd');

  // 8. mobile width
  const m = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await m.addCookies([{ name: 'unraid_' + crypto.createHash('md5').update(HOST).digest('hex'), value: sessionId(), domain: HOST, path: '/' }]);
  const mp = await m.newPage(); const me = []; watch(mp, me);
  await mp.goto(`http://${HOST}:81/AppTab-ZzConsole`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2500));
  const sc = await scrollInfo(mp);
  expect(!sc.h, `375px: no horizontal scroll (h=${sc.h} v=${sc.v})`);
  await mp.screenshot({ path: `${OUT}/apptabs-console-375.png` });
  expect(me.length === 0, '375px errors: ' + (me.join(' | ') || 'none'));
  await m.close();

  // 9. missing container: a message, not a blank frame
  const gp = await ctx.newPage(); const ge = []; watch(gp, ge);
  const before2 = ttyds().length;
  await gp.goto(`http://${HOST}:81/AppTab-ZzGhost`, { waitUntil: 'load' });
  const msg = (await gp.locator('#atb-problem').innerText()).replace(/\s+/g, ' ');
  expect(/no Docker container named no-such-box-xyz/.test(msg) && (await gp.locator('#atb-frame').count()) === 0, 'missing container shows: ' + msg.slice(0, 140));
  await gp.screenshot({ path: `${OUT}/apptabs-console-missing.png` });
  expect(ttyds().length === before2, 'and starts no ttyd');
  expect(ge.length === 0, 'message page errors: ' + (ge.join(' | ') || 'none'));

  // 10. the main page was clean, Backrest unchanged
  expect(errors.length === 0, 'console tab page errors: ' + (errors.join(' | ') || 'none'));
  const bp = await ctx.newPage(); const be = []; watch(bp, be);
  await bp.goto(`http://${HOST}:81/AppTab-Backrest`, { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));
  expect(bp.frames().some((f) => f.url().includes(':9898/')), 'Backrest tab still embeds http://' + HOST + ':9898/');
  expect(be.length === 0, 'Backrest page errors: ' + (be.join(' | ') || 'none'));
  console.log('     top bar: ' + (await topBar(bp)).join(', '));

  // 10b. the tab is edited while a client is attached: the ttyd goes, and so does the client inside the container
  expect(tmuxClients(TEST_SESSION).length === 1, 'a client is attached before the edit');
  const sp = await ctx.newPage();
  await sp.goto(`http://${HOST}:81/Settings/AppTabs`, { waitUntil: 'load', timeout: 60000 });
  const sf = () => sp.frameLocator('#atb-set-frame');
  await sf().getByRole('heading', { name: 'App Tabs' }).waitFor({ timeout: 20000 });
  await sf().getByRole('button', { name: 'Edit ZzConsole' }).click();
  await sf().locator('#atb-f-session').fill('');
  await sf().getByRole('button', { name: 'Save', exact: true }).click();
  await sf().getByText('Saved ZzConsole.').waitFor({ timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2500));
  expect(apptabsTtyds().length === 0, `edit while attached: the old ttyd is stopped (${apptabsTtyds().length} left)`);
  expect(tmuxClients(TEST_SESSION).length === 0, `edit while attached: no tmux client left in the container (${tmuxClients(TEST_SESSION).length})`);
  await sf().getByRole('button', { name: 'Edit ZzConsole' }).click();
  await sf().locator('#atb-f-session').fill(TEST_SESSION);
  await sf().getByRole('button', { name: 'Save', exact: true }).click();
  await sf().getByText('Saved ZzConsole.').waitFor({ timeout: 20000 });
  await sp.close();

  // 11. no credential anywhere we can see
  const ps = ssh(`ps -eo args | awk '$1 ~ /ttyd$/ || ($1 ~ /docker$/ && $2 == "exec") || $2 ~ /console-attach/'`);
  console.log('     argv of the console processes (ps): ' + ps.trim().split('\n').map((l) => l.replace(/-t theme \S+/, '').slice(0, 230)).join(' || '));
  expect(!/passw|token|secret|basic|-c [^ ]+:[^ ]+/i.test(ps.replace(/csrf/gi, '')), 'ps: no credential in any ttyd/logterminal argv (the APPTABS_CONN id in a docker exec argv is a random tag that grants nothing)');
  const insp = ssh(`docker inspect ${CONTAINER} --format '{{json .Config.Cmd}} {{json .Args}}'`);
  expect(!/apptabs|logterminal/.test(insp), 'docker inspect of the container does not mention the console tab');
  const logs = ssh('tail -n 300 /var/log/syslog | grep -iE "ttyd|apptabs|logterminal" | grep -iE "passw|token|secret|authorization" || true').trim();
  expect(logs === '', 'syslog: no credential line about ttyd/apptabs: ' + (logs || 'clean'));
  await ctx.close();
  await new Promise((r) => setTimeout(r, 2500));
  const left = strays();
  expect(left.length === 0, 'with every page closed no wrapper or docker exec is left on the host: ' + (left.map((l) => l.slice(0, 90)).join(' || ') || 'none'));
  expect(tmuxClients(TEST_SESSION).length === 0, 'and no tmux client is left in the container');
}

async function consoleClean(browser) {
  const ctx = await newCtx(browser, 1920, 1012);
  const errors = []; const page = await ctx.newPage(); watch(page, errors);
  await gotoSettings(page);
  const had = apptabsTtyds().length;
  const a = await deleteTab(page, 'ZzConsole');
  const b = await deleteTab(page, 'ZzGhost');
  console.log(`     deleted ZzConsole=${a} ZzGhost=${b}; console ttyd before=${had} after=${apptabsTtyds().length}`);
  expect(apptabsTtyds().length === 0, 'deleting the tab through the save path stopped its ttyd');
  expect(!ssh('ls /var/tmp | grep _apptabs-Zz || true').trim(), 'and removed its socket file');
  const cfg = ssh('cat /boot/config/plugins/app.tabs/tabs.json');
  expect(!cfg.includes('ZzConsole') && !cfg.includes('ZzGhost'), 'tabs.json no longer lists them');
  console.log('     tabs.json now: ' + JSON.stringify(JSON.parse(cfg)).slice(0, 300));
  console.log('     tabs.json.bak: ' + JSON.stringify(JSON.parse(ssh('cat /boot/config/plugins/app.tabs/tabs.json.bak'))).slice(0, 400));
  expect(errors.length === 0, 'errors: ' + (errors.join(' | ') || 'none'));
  await ctx.close();
}

async function consoleReal(browser) {
  // The REAL session: attach, wait, screenshot, disconnect. No keyboard, no mouse, no clicks.
  const cl = tmuxClients('claude');
  console.log('     existing clients on the real session before: ' + (cl.join(', ') || 'none'));
  const [mw, mh] = cl.length ? cl[0].split('x').map(Number) : [0, 0];
  // Never smaller than an existing client (tmux sizes the window to the smallest), so the viewer cannot shrink Kieren's window.
  const cols = Math.max(mw + 2, 120), rows = Math.max(mh + 2, 40);
  // measured: ~18.4 px per row and ~290 px of GUI chrome around the terminal at this theme
  const ctx = await newCtx(browser, Math.ceil(cols * 9.2), Math.ceil(rows * 18.5) + 290);
  const errors = []; const page = await ctx.newPage(); watch(page, errors);
  await page.goto(`http://${HOST}:81/AppTab-Claude`, { waitUntil: 'load', timeout: 60000 });
  await page.locator('#atb-frame').waitFor({ timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3500));
  console.log('     clients on the real session while attached: ' + tmuxClients('claude').join(', '));
  await page.screenshot({ path: `${OUT}/apptabs-console-real.png` });
  await page.close();
  await ctx.close();
  await new Promise((r) => setTimeout(r, 1500));
  console.log('     clients on the real session after disconnect: ' + (tmuxClients('claude').join(', ') || 'none'));
  expect(tmuxClients('claude').length === cl.length, 'the attach left no client behind');
  expect(errors.length === 0, 'errors: ' + (errors.join(' | ') || 'none'));
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
  const MODES = { shots, exercise, setup, pages, 'console-setup': consoleSetup, 'console-test': consoleTest, 'console-clean': consoleClean, 'console-real': consoleReal };
  if (!MODES[mode]) { console.error('usage: live-check.js ' + Object.keys(MODES).join('|') + ' [outDir]'); process.exit(2); }
  const browser = await chromium.launch({ executablePath: headlessShell() });
  try { await MODES[mode](browser); } finally { await browser.close(); }
  console.log(bad ? `${bad} FAILED` : 'all ok');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
