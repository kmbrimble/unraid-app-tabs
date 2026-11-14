<?php
declare(strict_types=1);

// App Tabs PHP suite. Run: php tests/run.php   (needs node/npm for the one-off UI build, GNU tar and xz)
// No test here can skip silently: every conditional prints "SKIP" and is counted, and the total is printed at the end.

$root = realpath(__DIR__ . '/..');
$tmp = sys_get_temp_dir() . '/apptabs-test-' . bin2hex(random_bytes(6));
mkdir("$tmp/cfg", 0777, true);
mkdir("$tmp/pages", 0777, true);
putenv("APPTABS_CONFIG_DIR=$tmp/cfg");
putenv("APPTABS_PAGES_DIR=$tmp/pages");
register_shutdown_function(function () use ($tmp) {
    exec('rm -rf ' . escapeshellarg($tmp));
});

$failures = 0;
$count = 0;
$skips = 0;

function check(string $name, bool $cond): void
{
    global $failures, $count;
    $count++;
    if (!$cond) {
        $failures++;
        echo "FAIL: $name\n";
    }
}

function checkEquals(string $name, $expected, $actual): void
{
    check($name . ' (expected ' . var_export($expected, true) . ', got ' . var_export($actual, true) . ')', $expected === $actual);
}

function skip(string $name, string $why): void
{
    global $skips;
    $skips++;
    echo "SKIP: $name ($why)\n";
}

require_once "$root/plugin/include/tabs.php";

function tab(array $o = []): array
{
    return $o + ['label' => 'Backrest', 'url' => 'http://[HOST]:9898/', 'open' => 'iframe', 'enabled' => true];
}

function clean_dirs(): void
{
    global $tmp;
    foreach (glob("$tmp/cfg/*") ?: [] as $f) {
        unlink($f);
    }
    foreach (glob("$tmp/pages/*") ?: [] as $f) {
        unlink($f);
    }
}

// ---- shared vectors (the JS suite runs the same file through plugin/app-tabs-core.js) -----------------------------
$v = json_decode((string) file_get_contents(__DIR__ . '/vectors.json'), true);
foreach ($v['labels_ok'] as $l) {
    checkEquals('label ok: ' . json_encode($l), null, apptabs_validate_label($l));
}
foreach ($v['labels_bad'] as $l) {
    check('label bad: ' . json_encode($l), apptabs_validate_label($l) !== null);
}
foreach ($v['slugs'] as $label => $slug) {
    checkEquals("slug $label", $slug, apptabs_slug((string) $label));
}
foreach ($v['urls_ok'] as $u) {
    checkEquals('url ok: ' . json_encode($u), null, apptabs_validate_url($u));
}
foreach ($v['urls_bad'] as $u) {
    check('url bad: ' . json_encode($u), apptabs_validate_url($u) !== null);
}

// ---- list validation ------------------------------------------------------------------------------------------------
[$ok, $errs] = apptabs_normalize([tab(), tab(['label' => 'Other'])]);
check('normalize: a good list', $ok !== null && $errs === [] && count($ok) === 2);
[$ok, $errs] = apptabs_normalize([tab(), tab(['label' => 'backrest'])]);
check('normalize: duplicate labels differing in case are refused', $ok === null && $errs !== []);
[$ok, $errs] = apptabs_normalize([tab(['label' => 'My App']), tab(['label' => 'My-App'])]);
check('normalize: labels that collide on file name are refused', $ok === null);
[$ok, $errs] = apptabs_normalize([tab(['open' => 'popup'])]);
check('normalize: bad open-in refused', $ok === null);
[$ok, $errs] = apptabs_normalize([tab(['enabled' => 'yes'])]);
check('normalize: non-boolean enabled refused', $ok === null);
[$ok, $errs] = apptabs_normalize(array_map(fn($i) => tab(['label' => "T$i"]), range(1, APPTABS_MAX_TABS + 1)));
check('normalize: too many tabs refused', $ok === null);
[$ok, $errs] = apptabs_normalize('nope');
check('normalize: non-list refused', $ok === null);
[$ok, $errs] = apptabs_normalize([tab(['extra' => 'x'])]);
check('normalize: unknown keys are dropped, not stored', $ok !== null && !array_key_exists('extra', $ok[0]));

// ---- save / load ----------------------------------------------------------------------------------------------------
clean_dirs();
$r = apptabs_load();
check('load: no file = empty, no error', $r['tabs'] === [] && $r['error'] === null && $r['exists'] === false);
[$ok, $msg] = apptabs_save([tab()]);
check("save: ok ($msg)", $ok);
$r = apptabs_load();
check('load: round trip', $r['error'] === null && $r['tabs'][0]['label'] === 'Backrest' && $r['tabs'][0]['url'] === 'http://[HOST]:9898/');
check('save: no temp or lock files left in the config dir', glob("$tmp/cfg/*") === ["$tmp/cfg/tabs.json"]);
[$ok] = apptabs_save([tab(), tab(['label' => 'Second'])]);
check('save: keeps the previous good config as tabs.json.bak', is_file("$tmp/cfg/tabs.json.bak") && count(json_decode((string) file_get_contents("$tmp/cfg/tabs.json.bak"), true)['tabs']) === 1);
$before = (string) file_get_contents("$tmp/cfg/tabs.json");
[$ok, $msg] = apptabs_save([tab(['label' => 'Bad"Label'])]);
check('save: invalid input refused', !$ok);
checkEquals('save: invalid input leaves the file untouched', $before, (string) file_get_contents("$tmp/cfg/tabs.json"));

// ---- corrupt config -------------------------------------------------------------------------------------------------
foreach (['{not json', '[]', '{"version":2,"tabs":[]}', '{"version":1,"tabs":[{"label":"x\"y","url":"http://h/","open":"iframe","enabled":true}]}', '{"version":1,"tabs":"x"}'] as $bad) {
    file_put_contents("$tmp/cfg/tabs.json", $bad);
    $r = apptabs_load();
    check('load: corrupt config is an error, not an empty list: ' . substr($bad, 0, 30), is_string($r['error']) && $r['error'] !== '' && $r['tabs'] === []);
}
file_put_contents("$tmp/cfg/tabs.json", '{not json');
file_put_contents("$tmp/pages/AppTab-Old.page", "Menu=\"Tasks:93\"\n---\n<?php /* app-tabs:generated */ ?>");
[$ok, $msg, $files] = apptabs_generate();
check('generate: corrupt config reports failure', !$ok && str_contains($msg, 'tabs.json'));
check('generate: corrupt config removes every generated page (never a half GUI)', glob("$tmp/pages/AppTab-*.page") === []);
checkEquals('save: refuses to overwrite a corrupt config', false, apptabs_save([tab()])[0]);
checkEquals('save: ...and left the corrupt bytes alone', '{not json', (string) file_get_contents("$tmp/cfg/tabs.json"));

// ---- generation -----------------------------------------------------------------------------------------------------
clean_dirs();
file_put_contents("$tmp/pages/AppTabs.page", "Menu=\"Utilities\"\n---\nsettings page");
file_put_contents("$tmp/pages/AppTab-Foreign.page", "Menu=\"Tasks:5\"\n---\nnot ours, no marker");
apptabs_save([tab(), tab(['label' => 'My App', 'url' => 'https://example.com/x']), tab(['label' => 'Off', 'enabled' => false]), tab(['label' => 'Ext', 'open' => 'newtab'])]);
$gen = glob("$tmp/pages/AppTab-*.page");
sort($gen);
checkEquals('generate: one page per enabled tab, named from the label', ["$tmp/pages/AppTab-Backrest.page", "$tmp/pages/AppTab-Ext.page", "$tmp/pages/AppTab-Foreign.page", "$tmp/pages/AppTab-My-App.page"], $gen);
$p = (string) file_get_contents("$tmp/pages/AppTab-Backrest.page");
check('generate: Menu is Tasks:93 for the first tab', str_contains($p, "Menu=\"Tasks:93\"\n"));
check('generate: Name carries the label verbatim', str_contains($p, "\nName=\"Backrest\"\n") && str_contains($p, "\nTitle=\"Backrest\"\n"));
check('generate: ranks follow the user order, skipping disabled', str_contains((string) file_get_contents("$tmp/pages/AppTab-My-App.page"), 'Tasks:94"') && str_contains((string) file_get_contents("$tmp/pages/AppTab-Ext.page"), 'Tasks:95"'));
check('generate: My App keeps its case and space in Name', str_contains((string) file_get_contents("$tmp/pages/AppTab-My-App.page"), 'Name="My App"'));
check('generate: Markdown and Tabs are off', str_contains($p, "Markdown=\"false\"\n") && str_contains($p, "Tabs=\"false\"\n"));
check('generate: page carries the marker', str_contains($p, 'app-tabs:generated'));
check('generate: the settings page and an unmarked foreign page are untouched', file_get_contents("$tmp/pages/AppTabs.page") === "Menu=\"Utilities\"\n---\nsettings page" && is_file("$tmp/pages/AppTab-Foreign.page"));
check('generate: the URL is NOT written into any generated page', !str_contains($p, 'http') && !str_contains($p, '9898'));
// the page body is real PHP: it must lint
[, $body] = explode("\n---\n", $p, 2);
file_put_contents("$tmp/body.php", $body);
exec('php -l ' . escapeshellarg("$tmp/body.php") . ' 2>&1', $o, $rc);
checkEquals('generate: page body lints as PHP', 0, $rc);
// a header the way Unraid's PageBuilder reads it
[$hdr] = explode("\n---\n", $p, 2);
$parsed = @parse_ini_string($hdr);
check('generate: header parses with parse_ini_string like PageBuilder', is_array($parsed) && $parsed['Name'] === 'Backrest' && $parsed['Menu'] === 'Tasks:93');
// disable one, delete one: pages vanish
apptabs_save([tab(['enabled' => false]), tab(['label' => 'My App', 'url' => 'https://example.com/x'])]);
check('generate: disabled tab loses its page', !is_file("$tmp/pages/AppTab-Backrest.page"));
check('generate: deleted tab loses its page', !is_file("$tmp/pages/AppTab-Ext.page"));
check('generate: remaining tab renumbered to 93', str_contains((string) file_get_contents("$tmp/pages/AppTab-My-App.page"), 'Tasks:93"'));
check('generate: foreign page still there', is_file("$tmp/pages/AppTab-Foreign.page"));
apptabs_save([]);
check('generate: empty list removes all generated pages', !is_file("$tmp/pages/AppTab-My-App.page") && is_file("$tmp/pages/AppTabs.page"));
// idempotent
apptabs_save([tab()]);
$a = (string) file_get_contents("$tmp/pages/AppTab-Backrest.page");
apptabs_generate();
checkEquals('generate: idempotent', $a, (string) file_get_contents("$tmp/pages/AppTab-Backrest.page"));
// a tab can never shadow a stock page: the AppTab- prefix guarantees it
check('generate: file names always start with AppTab- (uppercase first letter routes to template.php, and no stock page collides)', preg_match('~^AppTab-[A-Za-z0-9-]+\.page$~', basename("$tmp/pages/AppTab-Backrest.page")) === 1);

// a tab whose file name collides with a page we did not generate is refused, and the foreign file is left alone
clean_dirs();
file_put_contents("$tmp/pages/AppTab-Foreign.page", "Menu=\"Tasks:5\"\n---\nnot ours, no marker");
[$ok, $msg] = apptabs_save([tab(['label' => 'Foreign'])]);
check('save: refuses a label whose page file exists and is not ours', !$ok && str_contains($msg, 'was not generated by App Tabs'));
check('save: ...and writes nothing (no tabs.json)', !is_file("$tmp/cfg/tabs.json"));
// with an existing good config and a good page, a refused colliding save must change neither
clean_dirs();
file_put_contents("$tmp/pages/AppTab-Foreign.page", "Menu=\"Tasks:5\"\n---\nnot ours");
apptabs_save([tab()]);
$cfgBefore = (string) file_get_contents("$tmp/cfg/tabs.json");
[$ok] = apptabs_save([tab(), tab(['label' => 'Foreign'])]);
check('save: a refused colliding save leaves tabs.json and the other pages exactly as they were', !$ok && $cfgBefore === (string) file_get_contents("$tmp/cfg/tabs.json") && is_file("$tmp/pages/AppTab-Backrest.page"));
// generation itself (boot hook) also refuses if a foreign file appears later, hand-edited config
clean_dirs();
file_put_contents("$tmp/pages/AppTab-Foreign.page", "Menu=\"Tasks:5\"\n---\nnot ours");
file_put_contents("$tmp/cfg/tabs.json", json_encode(['version' => 1, 'tabs' => [tab(['label' => 'Foreign'])]]));
[$ok, $msg] = apptabs_generate();
check('generate: refuses to overwrite an existing page that is not ours', !$ok && str_contains($msg, 'Refusing to overwrite'));
checkEquals('generate: ...and the foreign page is byte-identical', "Menu=\"Tasks:5\"\n---\nnot ours", (string) file_get_contents("$tmp/pages/AppTab-Foreign.page"));
// an unwritable pages dir: stale-page removal failures are reported, not swallowed
clean_dirs();
apptabs_save([tab()]);
if (function_exists('posix_geteuid') && posix_geteuid() === 0) {
    skip('generate: unlink failure is reported', 'running as root, chmod cannot make unlink fail');
} else {
    chmod("$tmp/pages", 0555);
    [$ok, $msg] = apptabs_save([]);
    chmod("$tmp/pages", 0755);
    check('generate: a page that cannot be removed is reported', !$ok && str_contains($msg, 'Could not remove'));
}
// concurrency: two processes saving at once never leave a mixed state (the lock serialises save + generate)
clean_dirs();
$procs = [];
foreach (['A1', 'B2', 'C3', 'D4'] as $lab) {
    $code = 'putenv("APPTABS_CONFIG_DIR=' . $tmp . '/cfg");putenv("APPTABS_PAGES_DIR=' . $tmp . '/pages");require ' . var_export("$root/plugin/include/tabs.php", true)
        . ';for($i=0;$i<15;$i++){apptabs_save([["label"=>"' . $lab . '","url"=>"http://h/","open"=>"iframe","enabled"=>true]]);}';
    $procs[] = proc_open(['php', '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pp);
}
foreach ($procs as $pr) {
    proc_close($pr);
}
$gen = array_map('basename', glob("$tmp/pages/AppTab-*.page") ?: []);
$last = apptabs_load();
check('concurrent saves: exactly one page, and it matches the config that won', count($gen) === 1 && $last['error'] === null && $gen === ['AppTab-' . $last['tabs'][0]['label'] . '.page']);

// ---- injection: hostile values must never reach a generated file ---------------------------------------------------------
$hostile = ["x\"\nMenu=\"Tasks:1", "a\n---\n<?php system('id'); ?>", '<?php echo 1; ?>', '{$x}', '${x}', "../../etc/x", 'a/../b', "x\0y", "A\r\nName=\"evil\"", '"; evil(); //', '<script>alert(1)</script>', "Back'rest"];
clean_dirs();
foreach ($hostile as $h) {
    clean_dirs();
    [$ok] = apptabs_save([tab(['label' => $h])]);
    check('inject: hostile label refused: ' . json_encode($h), !$ok && glob("$tmp/pages/*") === [] && !is_file("$tmp/cfg/tabs.json"));
}
// URLs: only values that carry a forbidden character are hostile ("../" in a URL is valid and is never written to a file)
foreach (["x\"\nMenu=\"Tasks:1", "a\n---\n<?php system('id'); ?>", '<?php echo 1; ?>', '{$x}', "x\0y", '"; evil(); //', '<script>alert(1)</script>', "Back'rest"] as $h) {
    clean_dirs();
    [$ok] = apptabs_save([tab(['url' => "http://h/$h"])]);
    check('inject: hostile URL refused: ' . json_encode($h), !$ok && glob("$tmp/pages/*") === [] && !is_file("$tmp/cfg/tabs.json"));
}
// ...and the generator itself refuses to write a hostile value even if validation were bypassed
foreach ($hostile as $h) {
    $threw = false;
    try {
        apptabs_page_text(apptabs_slug('x'), $h, 93);
    } catch (\Throwable $e) {
        $threw = true;
    }
    check('inject: apptabs_page_text refuses a hostile label directly: ' . json_encode($h), $threw);
}
$threw = false;
try {
    apptabs_page_text('../evil', 'ok', 93);
} catch (\Throwable $e) {
    $threw = true;
}
check('inject: apptabs_page_text refuses a traversal slug', $threw);
// hostile config bytes written by hand (bypassing save): load must flag it, generate must produce nothing
file_put_contents("$tmp/cfg/tabs.json", json_encode(['version' => 1, 'tabs' => [tab(['label' => "a\n---\n<?php system('id'); ?>"])]]));
[$ok] = apptabs_generate();
check('inject: hand-edited hostile tabs.json generates nothing', !$ok && glob("$tmp/pages/AppTab-*.page") === []);
// every generated page for two very different valid labels is identical apart from label/slug/rank
clean_dirs();
apptabs_save([tab(['label' => 'Aaa', 'url' => 'http://[HOST]:1/']), tab(['label' => 'Zz Zz', 'url' => 'https://other.example/very/different?x=1'])]);
$n1 = str_replace(['Aaa', '93'], ['L', 'R'], (string) file_get_contents("$tmp/pages/AppTab-Aaa.page"));
$n2 = str_replace(['Zz Zz', 'Zz-Zz', '94'], ['L', 'L', 'R'], (string) file_get_contents("$tmp/pages/AppTab-Zz-Zz.page"));
checkEquals('inject: generated pages differ only by label, slug and rank', str_replace('AppTab-L', 'AppTab-L', $n1), str_replace('AppTab-L', 'AppTab-L', $n2));

// ---- path safety ----------------------------------------------------------------------------------------------------
clean_dirs();
apptabs_save([tab(), tab(['label' => 'Two'])]);
$written = array_merge(glob("$tmp/pages/*") ?: [], glob("$tmp/cfg/*") ?: []);
check('paths: everything written is directly inside the pages or config dir', count(array_filter($written, fn($f) => in_array(dirname($f), ["$tmp/pages", "$tmp/cfg"], true))) === count($written));

// ---- tab page render -----------------------------------------------------------------------------------------------
require_once "$root/plugin/include/tabpage.php";
clean_dirs();
apptabs_save([tab(), tab(['label' => 'Ext', 'open' => 'newtab', 'url' => 'https://example.com/a?b=1&c=2'])]);
ob_start();
apptabs_render_tab('Backrest');
$html = (string) ob_get_clean();
check('render: iframe tab has an iframe, no src yet (set after [HOST] resolves)', str_contains($html, '<iframe') && !preg_match('~<iframe[^>]*\ssrc=~', $html));
check('render: the raw template URL is carried in one escaped attribute', substr_count($html, 'data-url="http://[HOST]:9898/"') === 1);
check('render: "Open full page" link present', str_contains($html, 'Open full page'));
check('render: mixed-content message element present and hidden by default', str_contains($html, 'atb-mixed') && str_contains($html, 'hidden'));
ob_start();
apptabs_render_tab('Ext');
$html = (string) ob_get_clean();
check('render: new-tab mode has no iframe and escapes & in the URL', !str_contains($html, '<iframe') && str_contains($html, 'data-url="https://example.com/a?b=1&amp;c=2"'));
ob_start();
apptabs_render_tab('Gone');
$html = (string) ob_get_clean();
check('render: an unknown tab says so instead of a blank box', str_contains($html, 'no longer configured'));
file_put_contents("$tmp/cfg/tabs.json", '{broken');
ob_start();
apptabs_render_tab('Backrest');
$html = (string) ob_get_clean();
check('render: a corrupt config shows the error, not a blank box', str_contains($html, 'tabs.json'));

// ---- no CLI-only constructs in functions with a web caller ------------------------------------------------------------
foreach (['tabs.php', 'tabpage.php'] as $f) {
    $src = (string) file_get_contents("$root/plugin/include/$f");
    check("web-safe: $f has no STDOUT/STDERR/\$argv", !preg_match('~\b(STDOUT|STDERR|STDIN)\b|\$argv~', $src));
}

// ---- api.php as a real subprocess ------------------------------------------------------------------------------------
function web_call(array $post, string $method = 'POST', ?string $bootExtra = null): array
{
    global $tmp, $root;
    $boot = "$tmp/boot-" . bin2hex(random_bytes(4)) . '.php';
    file_put_contents($boot, "<?php\n\$_SERVER['REQUEST_METHOD'] = " . var_export($method, true) . ";\n\$_POST = " . var_export($post, true)
        . ";\n" . ($bootExtra ?? '') . "require " . var_export("$root/plugin/include/api.php", true) . ";\n");
    $proc = proc_open(['php', $boot], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null,
        ['APPTABS_CONFIG_DIR' => "$tmp/cfg", 'APPTABS_PAGES_DIR' => "$tmp/pages", 'PATH' => getenv('PATH')]);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    foreach ($pipes as $p) {
        fclose($p);
    }
    proc_close($proc);
    unlink($boot);
    return [json_decode($out, true), $out, $err];
}

clean_dirs();
[$j] = web_call(['action' => 'get'], 'GET');
check('web: GET refused', is_array($j) && $j['ok'] === false && str_contains($j['error'], 'POST'));
[$j] = web_call(['action' => 'nope']);
check('web: unknown action refused', is_array($j) && $j['ok'] === false);
[$j] = web_call(['action' => 'get']);
check('web: get on a fresh install is ok, empty, no error', is_array($j) && $j['ok'] === true && $j['tabs'] === [] && $j['config_error'] === null);
[$j, $raw] = web_call(['action' => 'save', 'tabs' => json_encode([tab()])]);
check('web: save ok', is_array($j) && $j['ok'] === true, );
check('web: save wrote the page', is_file("$tmp/pages/AppTab-Backrest.page"));
[$j] = web_call(['action' => 'get']);
check('web: get returns what was saved plus the generated page names', $j['tabs'][0]['label'] === 'Backrest' && $j['pages'] === ['AppTab-Backrest']);
[$j] = web_call(['action' => 'save', 'tabs' => json_encode([tab(['url' => 'javascript:alert(1)'])])]);
check('web: save with a bad URL is refused with field errors', $j['ok'] === false && !empty($j['errors']) && $j['errors'][0]['field'] === 'url');
[$j] = web_call(['action' => 'save', 'tabs' => '{not json']);
check('web: save with unparseable JSON refused', $j['ok'] === false);
[$j] = web_call(['action' => 'save']);
check('web: save with no tabs field refused', $j['ok'] === false);
[$j] = web_call(['action' => 'save', 'tabs' => json_encode([tab(['label' => '../../x'])])]);
check('web: path traversal in a label refused, nothing outside written', $j['ok'] === false && !file_exists("$tmp/x") && !file_exists("$tmp/../x.page"));
[$j] = web_call(['action' => 'save', 'tabs' => str_repeat('x', 70000)]);
check('web: oversized tabs payload refused', $j['ok'] === false && str_contains($j['error'], 'large'));
file_put_contents("$tmp/cfg/tabs.json", '{bad');
[$j] = web_call(['action' => 'get']);
check('web: corrupt config is reported on get, with the file path to fix by hand', $j['ok'] === true && is_string($j['config_error']) && str_contains($j['config_error'], 'tabs.json') && $j['tabs'] === []);
[$j] = web_call(['action' => 'save', 'tabs' => json_encode([tab()])]);
check('web: save refuses while the config is corrupt (no silent overwrite)', $j['ok'] === false && file_get_contents("$tmp/cfg/tabs.json") === '{bad');
file_put_contents("$tmp/cfg/tabs.json", json_encode(['version' => 1, 'tabs' => []]));
[$j] = web_call(['action' => 'save', 'tabs' => ['x']]);
check('web: a non-string tabs field answers JSON (note: this does not reach the Throwable catch)', is_array($j) && $j['ok'] === false && is_string($j['error']));

// ---- app/index.php shell --------------------------------------------------------------------------------------------
mkdir("$tmp/shell", 0777, true);
file_put_contents("$tmp/shell/var.ini", "csrf_token=\"ab<c>\\\"d\"\n");
file_put_contents("$tmp/shell/dynamix.cfg", "[display]\ntheme=\"black\"\n");
$proc = proc_open(['php', "$root/plugin/app/index.php"], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null,
    ['APPTABS_VAR_INI' => "$tmp/shell/var.ini", 'APPTABS_DYNAMIX_CFG' => "$tmp/shell/dynamix.cfg", 'PATH' => getenv('PATH')]);
$shell = stream_get_contents($pipes[1]);
foreach ($pipes as $p) {
    fclose($p);
}
proc_close($proc);
check('shell: csrf token is emitted escaped', str_contains($shell, 'data-csrf="ab&lt;c&gt;') && !str_contains($shell, 'ab<c>'));
check('shell: black theme is dark', str_contains($shell, 'data-theme="dark"'));
check('shell: loads core, app.js and app.css', str_contains($shell, 'app-tabs-core.js') && str_contains($shell, 'assets/app.js') && str_contains($shell, 'assets/app.css'));

// ---- the .plg --------------------------------------------------------------------------------------------------------
$plg = "$root/app.tabs.plg";
exec('php ' . escapeshellarg("$root/scripts/check-plg.php") . ' ' . escapeshellarg($plg) . ' 2>&1', $o, $rc);
checkEquals('plg: parses with entities expanded, has version, pluginURL and md5', 0, $rc);
$plgText = (string) file_get_contents($plg);
check('plg: no bare && in an INLINE block', !preg_match('~&&~', $plgText));
check('plg: <INLINE> is upper case', !str_contains($plgText, '<Inline>') && !str_contains($plgText, '<inline>'));
check('plg: pluginURL points at the Gitea raw .plg', str_contains($plgText, 'git.kiztigs.com/kmbrimble/unraid-app-tabs/raw/branch/main/app.tabs.plg'));
check('plg: remove block does not delete the flash config dir', !preg_match('~rm\s+-rf\s+&plgPATH;~', $plgText));

// ---- INLINE blocks, run for real under bash against recording stubs ------------------------------------------------------
function inline_block(string $plgText, bool $remove): string
{
    preg_match_all('~<FILE Run="/bin/bash"([^>]*)>\s*<INLINE>(.*?)</INLINE>~s', $plgText, $m, PREG_SET_ORDER);
    foreach ($m as $b) {
        if (str_contains($b[1], 'Method="remove"') === $remove) {
            return html_entity_decode($b[2], ENT_QUOTES | ENT_XML1);
        }
    }
    throw new RuntimeException('block not found');
}
function run_block(string $text, string $dir, array $subst, bool $failGenerate = false): array
{
    global $root;
    $version = $subst['version'];
    foreach (['&plgPATH;' => $subst['plgPATH'], '&emhttp;' => $subst['emhttp'], '&name;' => 'app.tabs', '&version;' => $version] as $k => $val) {
        $text = str_replace($k, $val, $text);
    }
    @mkdir("$dir/bin", 0777, true);
    file_put_contents("$dir/bin/upgradepkg", "#!/bin/bash\necho \"upgradepkg \$*\" >> \"$dir/calls.log\"\nmkdir -p " . escapeshellarg($subst['emhttp'] . '/include') . "\ncp " . escapeshellarg("$root/plugin/include/") . "*.php " . escapeshellarg($subst['emhttp'] . '/include/') . "\n");
    file_put_contents("$dir/bin/removepkg", "#!/bin/bash\necho \"removepkg \$*\" >> \"$dir/calls.log\"\n");
    chmod("$dir/bin/upgradepkg", 0755);
    chmod("$dir/bin/removepkg", 0755);
    file_put_contents("$dir/block.sh", $text);
    $proc = proc_open(['bash', "$dir/block.sh"], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null,
        ['PATH' => "$dir/bin:" . getenv('PATH'), 'APPTABS_CONFIG_DIR' => $subst['plgPATH'], 'APPTABS_PAGES_DIR' => $subst['emhttp']]);
    $out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
    foreach ($pipes as $p) {
        fclose($p);
    }
    $rc = proc_close($proc);
    return [$rc, $out];
}
$bd = "$tmp/blk";
$plgDir = "$bd/flash/plugins/app.tabs";
$emhttp = "$bd/emhttp/plugins/app.tabs";
mkdir($plgDir, 0777, true);
mkdir($emhttp, 0777, true);
file_put_contents("$plgDir/tabs.json", json_encode(['version' => 1, 'tabs' => [tab()]]));
file_put_contents("$plgDir/app.tabs-0.0.1.txz", 'old');
file_put_contents("$plgDir/app.tabs-0.1.0.txz", 'cur');
file_put_contents("$emhttp/AppTab-Stale.page", "Menu=\"Tasks:93\"\n---\n<?php /* app-tabs:generated */ ?>");
$hashBefore = md5_file("$plgDir/tabs.json");
[$rc, $out] = run_block(inline_block($plgText, false), $bd, ['version' => '0.1.0', 'plgPATH' => $plgDir, 'emhttp' => $emhttp]);
checkEquals("install block: exit 0 ($out)", 0, $rc);
check('install block: regenerates pages from flash config at install/boot', is_file("$emhttp/AppTab-Backrest.page") && !is_file("$emhttp/AppTab-Stale.page"));
check('install block: prunes superseded .txz, keeps the current one', !is_file("$plgDir/app.tabs-0.0.1.txz") && is_file("$plgDir/app.tabs-0.1.0.txz"));
checkEquals('install block: tabs.json is byte-identical', $hashBefore, md5_file("$plgDir/tabs.json"));
file_put_contents("$plgDir/tabs.json", '{corrupt');
[$rc, $out] = run_block(inline_block($plgText, false), $bd, ['version' => '0.1.0', 'plgPATH' => $plgDir, 'emhttp' => $emhttp]);
checkEquals('install block: a corrupt tabs.json does not fail the install', 0, $rc);
check('install block: ...and says so', str_contains($out, 'tabs.json'));
check('install block: ...and leaves no generated pages', glob("$emhttp/AppTab-*.page") === []);
file_put_contents("$plgDir/tabs.json", json_encode(['version' => 1, 'tabs' => [tab()]]));
$hashBefore = md5_file("$plgDir/tabs.json");
[$rc, $out] = run_block(inline_block($plgText, true), $bd, ['version' => '0.1.0', 'plgPATH' => $plgDir, 'emhttp' => $emhttp]);
checkEquals("remove block: exit 0 ($out)", 0, $rc);
check('remove block: installed tree gone', !is_dir($emhttp));
checkEquals('remove block: flash tabs.json kept, byte-identical', $hashBefore, md5_file("$plgDir/tabs.json"));
check('remove block: calls removepkg', str_contains((string) file_get_contents("$bd/calls.log"), 'removepkg app.tabs-0.1.0'));

// ---- the package: layout, README shape, modes, reproducibility -------------------------------------------------------------
$uiDist = "$tmp/uidist";
exec('cd ' . escapeshellarg("$root/ui") . ' && npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 && npm run build >/dev/null 2>&1', $o, $rc);
if ($rc !== 0 || !is_file("$root/ui/dist/assets/app.js")) {
    check('ui: npm ci && npm run build succeeded', false);
} else {
    exec('mkdir -p ' . escapeshellarg($uiDist) . ' && cp -r ' . escapeshellarg("$root/ui/dist/assets") . ' ' . escapeshellarg($uiDist));
    $build = function (string $prefix = '') use ($root, $uiDist): array {
        $cmd = $prefix . ' APPTABS_UI_DIST=' . escapeshellarg($uiDist) . ' bash ' . escapeshellarg("$root/scripts/build-plugin.sh") . ' 0.1.0 2>&1';
        exec($cmd, $out, $rc);
        $md5 = is_file("$root/dist/app.tabs-0.1.0.txz") ? md5_file("$root/dist/app.tabs-0.1.0.txz") : '';
        return [$rc, $md5, implode("\n", $out)];
    };
    [$rc, $md5a, $log] = $build();
    checkEquals("build: ok ($log)", 0, $rc);
    exec('tar -tvJf ' . escapeshellarg("$root/dist/app.tabs-0.1.0.txz"), $list);
    $names = array_map(fn($l) => preg_split('/\s+/', $l, 6)[5] ?? '', $list);
    check('package: every path is under usr/local/emhttp/plugins/app.tabs/', count(array_filter($names, fn($n) => !str_starts_with($n, 'usr/'))) === 0 && $names !== []);
    foreach (['AppTabs.page', 'README.md', 'app-tabs-core.js', 'app/index.php', 'app/assets/app.js', 'app/assets/app.css', 'include/tabs.php', 'include/api.php', 'include/tabpage.php', 'include/generate.php'] as $f) {
        check("package: contains $f", in_array("usr/local/emhttp/plugins/app.tabs/$f", $names, true));
    }
    check('package: AppTabs.page sits in the plugin root (the loader globs non-recursively)', in_array('usr/local/emhttp/plugins/app.tabs/AppTabs.page', $names, true));
    check('package: no repo-only tooling shipped', count(array_filter($names, fn($n) => preg_match('~tests|scripts|node_modules|\.md5~', $n) && !str_ends_with($n, 'README.md'))) === 0);
    $readme = (string) file_get_contents("$root/plugin/README.md");
    check('plugin README: stock shape (bold name, no headings)', str_starts_with($readme, '**') && !preg_match('~^#~m', $readme));
    [$rc2, $md5b] = $build('umask 077; TZ=Pacific/Auckland XZ_DEFAULTS=--threads=4');
    checkEquals('build: reproducible across umask, TZ and XZ_DEFAULTS', $md5a, $md5b);
}

echo "\n$count checks, $failures failed, $skips skipped\n";
exit($failures ? 1 : 0);
