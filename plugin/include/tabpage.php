<?php
/**
 * Renders one App Tabs top-bar page: a thin iframe host (or, for open-in "new browser tab", a landing page with the
 * link). Called by the generated AppTab-<slug>.page with only the slug; the tab is looked up in tabs.json here and
 * everything is escaped on output. The raw URL (with its [HOST] placeholder) goes into one data attribute; the browser
 * resolves [HOST] to the host the GUI was opened on, so nothing server-side guesses at the address.
 *
 * Runs under php-fpm: no CLI-only constructs.
 */

declare(strict_types=1);

require_once __DIR__ . '/tabs.php';

function apptabs_h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
}

function apptabs_render_tab(string $slug): void
{
    $cfg = apptabs_load();
    if ($cfg['error'] !== null) {
        echo '<p><strong>App Tabs:</strong> ' . apptabs_h($cfg['error']) . "</p>\n";
        return;
    }
    $tab = null;
    foreach ($cfg['tabs'] as $t) {
        if (apptabs_slug($t['label']) === $slug) {
            $tab = $t;
            break;
        }
    }
    if ($tab === null || !$tab['enabled']) {
        echo '<p>This tab is no longer configured. Open Settings, Utilities, App Tabs to change it.</p>' . "\n";
        return;
    }
    if ($tab['kind'] === 'console') {
        apptabs_render_console($slug, $tab);
        return;
    }
    $label = apptabs_h($tab['label']);
    $url = apptabs_h($tab['url']);
    $core = '/plugins/app.tabs/app-tabs-core.js';
    ?>
<style>
  #atb-bar { display: flex; justify-content: flex-end; margin: 0 0 6px; }
  #atb-frame { display: block; width: 100%; height: 70vh; border: 0; background: transparent; }
  #atb-mixed, #atb-landing { margin: 12px 0; padding: 12px 16px; border: 1px solid currentColor; border-radius: 6px; max-width: 48rem; }
  #atb-mixed[hidden], #atb-landing[hidden], #atb-frame[hidden] { display: none; }
</style>
<div id="atb-host" data-url="<?= $url ?>" data-open="<?= apptabs_h($tab['open']) ?>" data-label="<?= $label ?>">
  <div id="atb-bar"><a id="atb-open" target="_blank" rel="noopener">Open full page</a></div>
<?php if ($tab['open'] === 'iframe') { ?>
  <iframe id="atb-frame" title="<?= $label ?>"></iframe>
  <div id="atb-mixed" hidden role="alert">
    <strong>This tab cannot be shown here.</strong> Unraid is open over https, but <?= $label ?> is an http address, and the browser
    blocks an http page inside an https one (mixed content). Use "Open full page" above, or give the app an https address.
  </div>
  <noscript><p>App Tabs needs JavaScript to load <?= $label ?>.</p></noscript>
<?php } else { ?>
  <div id="atb-landing">
    <strong><?= $label ?></strong> is set to open in its own browser tab.
    <p><a id="atb-open-main" class="button" target="_blank" rel="noopener">Open <?= $label ?></a></p>
  </div>
<?php } ?>
</div>
<script src="<?= $core ?>"></script>
<script>
(function () {
  'use strict';
  var host = document.getElementById('atb-host');
  var core = window.appTabs;
  var frame = document.getElementById('atb-frame');
  var link = document.getElementById('atb-open');
  var main = document.getElementById('atb-open-main');
  if (!core) { host.insertAdjacentText('beforeend', 'App Tabs could not load its script (app-tabs-core.js).'); return; }
  var url = core.resolveUrl(host.getAttribute('data-url'), location.hostname);
  link.href = url;
  if (main) main.href = url;
  if (!frame) return;
  if (core.isMixedContent(location.protocol, url)) {
    frame.hidden = true;
    document.getElementById('atb-mixed').hidden = false;
    return;
  }
  frame.src = url;
  // Fill the viewport below the Unraid header so the app scrolls inside the frame and the page itself does not.
  // footer#footer is fixed on the wide themes and in-flow on narrow ones; trim any remaining page overflow.
  function fit() {
    var footer = document.getElementById('footer');
    var below = footer && getComputedStyle(footer).position === 'fixed' ? footer.offsetHeight : 0;
    var h = window.innerHeight - frame.getBoundingClientRect().top - below - 8;
    frame.style.height = Math.max(320, h) + 'px';
    var over = document.documentElement.scrollHeight - window.innerHeight;
    if (over > 0) frame.style.height = Math.max(320, frame.offsetHeight - over) + 'px';
  }
  window.addEventListener('resize', fit);
  window.addEventListener('load', fit);
  fit();
  setTimeout(fit, 400);
})();
</script>
<?php
}

/**
 * A Docker console tab. Only runs because an authenticated GUI request loaded this page (never at install or boot).
 * apptabs_console_prepare() verifies the container and tmux session and makes sure the host's ttyd is serving this
 * tab's socket; the iframe then points at nginx's /logterminal/ proxy for it (same origin, behind the GUI login).
 * Every failure is a message on the page, never a blank frame.
 */
function apptabs_render_console(string $slug, array $tab): void
{
    $label = apptabs_h($tab['label']);
    try {
        [$ok, $msg, $src] = apptabs_console_prepare($slug, $tab);
    } catch (\Throwable $e) {
        error_log('app.tabs console: ' . get_class($e) . ': ' . $e->getMessage());
        [$ok, $msg, $src] = [false, 'The console could not be prepared (' . get_class($e) . '). See the system log.', ''];
    }
    ?>
<style>
  #atb-bar { display: flex; justify-content: flex-end; gap: 12px; margin: 0 0 6px; }
  #atb-frame { display: block; width: 100%; height: 70vh; border: 0; background: transparent; }
  #atb-problem { margin: 12px 0; padding: 12px 16px; border: 1px solid currentColor; border-radius: 6px; max-width: 48rem; }
</style>
<div id="atb-host" data-kind="console" data-label="<?= $label ?>">
<?php if (!$ok) { ?>
  <div id="atb-problem" role="alert">
    <strong>The <?= $label ?> console is not available.</strong>
    <p><?= apptabs_h($msg) ?></p>
    <p><a class="button" href="">Try again</a></p>
  </div>
<?php } else { ?>
  <div id="atb-bar"><a id="atb-reconnect" href="#">Reconnect</a><a id="atb-open" href="<?= apptabs_h($src) ?>" target="_blank" rel="noopener">Open full page</a></div>
  <iframe id="atb-frame" title="<?= $label ?> console" src="<?= apptabs_h($src) ?>"></iframe>
<?php } ?>
</div>
<?php if ($ok) { ?>
<script>
(function () {
  'use strict';
  var frame = document.getElementById('atb-frame');
  // Fill the viewport below the Unraid header (the same fit as the URL tabs).
  function fit() {
    var footer = document.getElementById('footer');
    var below = footer && getComputedStyle(footer).position === 'fixed' ? footer.offsetHeight : 0;
    var h = window.innerHeight - frame.getBoundingClientRect().top - below - 8;
    frame.style.height = Math.max(320, h) + 'px';
    var over = document.documentElement.scrollHeight - window.innerHeight;
    if (over > 0) frame.style.height = Math.max(320, frame.offsetHeight - over) + 'px';
  }
  window.addEventListener('resize', fit);
  window.addEventListener('load', fit);
  fit();
  setTimeout(fit, 400);
  // Same origin, so the terminal can be given keyboard focus as soon as it has loaded.
  frame.addEventListener('load', function () { try { frame.contentWindow.focus(); } catch (e) { /* not reachable: leave focus alone */ } });
  document.getElementById('atb-reconnect').addEventListener('click', function (e) { e.preventDefault(); location.reload(); });  // a page load re-runs the checks and restarts a dead ttyd
})();
</script>
<?php } ?>
<?php
}
