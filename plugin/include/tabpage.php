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
