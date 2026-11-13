<?php
/**
 * App Tabs library: the tab list (flash config), its validation, and generation of the top-bar .page files.
 *
 * Shared by the settings endpoint (api.php), the install/boot hook (generate.php) and the tab renderer (tabpage.php),
 * so nothing here may use CLI-only constructs (the stdio constants, argv) or report through an exit code: every
 * function returns a result.
 *
 * Trust model: labels and URLs are untrusted. A label becomes the .page file name (via a whitelisted slug) and the
 * Name/Title header, so it is held to a strict character set (the stock top bar prints Name unescaped). A URL is never
 * written into a generated page at all: the page carries only the slug, and tabpage.php looks the tab up in tabs.json
 * at render time and escapes on output. The JS twin of the label/URL rules is plugin/app-tabs-core.js; tests/vectors.json
 * runs through both.
 */

declare(strict_types=1);

const APPTABS_MAX_TABS = 12;
const APPTABS_FIRST_RANK = 93;      // Tasks:90 Tools, 91 SecretsMan, 92 NetMan; user tabs follow in the user's order
const APPTABS_MARKER = 'app-tabs:generated';
const APPTABS_MAX_JSON = 65536;

function apptabs_env(string $name, string $default): string
{
    $v = getenv($name);
    return $v !== false && $v !== '' ? $v : $default;
}

/** Flash config dir (tests override with APPTABS_CONFIG_DIR). */
function apptabs_config_dir(): string
{
    return rtrim(apptabs_env('APPTABS_CONFIG_DIR', '/boot/config/plugins/app.tabs'), '/');
}

/** Where generated .page files go: the plugin's installed root, because the page loader globs it non-recursively. */
function apptabs_pages_dir(): string
{
    return rtrim(apptabs_env('APPTABS_PAGES_DIR', dirname(__DIR__)), '/');
}

function apptabs_config_path(): string
{
    return apptabs_config_dir() . '/tabs.json';
}

function apptabs_validate_label(mixed $label): ?string
{
    if (!is_string($label) || $label === '') {
        return 'Enter a label.';
    }
    if (strlen($label) > 24) {
        return 'Use 24 characters or fewer.';
    }
    if (!preg_match('/\A(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9 ._+-]{0,22}[A-Za-z0-9])\z/', $label)) {
        return 'Use letters, digits, spaces and . _ + - only, starting and ending with a letter or digit.';
    }
    return null;
}

/** File-name stem for a label: runs of anything but letters/digits become one '-'. Case is kept. */
function apptabs_slug(string $label): string
{
    return trim((string) preg_replace('/[^A-Za-z0-9]+/', '-', $label), '-');
}

function apptabs_validate_url(mixed $url): ?string
{
    if (!is_string($url) || $url === '') {
        return 'Enter a URL.';
    }
    if (strlen($url) > 2048) {
        return 'That URL is too long.';
    }
    // Printable ASCII only (no controls, no Unicode spaces: encode them, or use punycode for a name), and none of the
    // characters that could break out of an attribute or a header.
    if (preg_match('/[^\x21-\x7e]|["\'`<>\\\\^{}|]/', $url)) {
        return 'The URL has a space or a character that is not allowed in a URL (encode it, for example %20).';
    }
    if (!preg_match('~\A(https?)://(\[HOST\]|\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?((?:[/?#]).*)?\z~', $url, $m)) {
        return 'Use an http:// or https:// address, for example http://[HOST]:9898/ (no user name or password).';
    }
    if (($m[3] ?? '') !== '' && ((int) $m[3] < 1 || (int) $m[3] > 65535)) {
        return 'The port must be between 1 and 65535.';
    }
    if ($m[2][0] === '[' && $m[2] !== '[HOST]' && (!str_contains($m[2], ':') || str_contains($m[2], ':::') || strlen($m[2]) > 47)) {
        return 'That is not a valid IPv6 address.';
    }
    $rest = $m[4] ?? '';
    if (str_contains($rest, '[') || str_contains($rest, ']')) {
        return 'Square brackets are only allowed as [HOST] or an IPv6 address in the host part.';
    }
    return null;
}

/**
 * Validate and normalise a decoded list. Returns [list|null, errors]; errors are {index, field, message}.
 * Only the four known keys survive, in a fixed order.
 */
function apptabs_normalize(mixed $tabs): array
{
    $errors = [];
    if (!is_array($tabs) || ($tabs !== [] && !array_is_list($tabs))) {
        return [null, [['index' => -1, 'field' => 'tabs', 'message' => 'Tabs must be a list.']]];
    }
    if (count($tabs) > APPTABS_MAX_TABS) {
        $errors[] = ['index' => -1, 'field' => 'tabs', 'message' => 'At most ' . APPTABS_MAX_TABS . ' tabs.'];
    }
    $out = [];
    $seen = [];
    foreach ($tabs as $i => $t) {
        if (!is_array($t)) {
            $errors[] = ['index' => $i, 'field' => 'tabs', 'message' => 'Each tab must be an object.'];
            continue;
        }
        $label = $t['label'] ?? null;
        $err = apptabs_validate_label($label);
        if ($err !== null) {
            $errors[] = ['index' => $i, 'field' => 'label', 'message' => $err];
        } else {
            $k = strtolower(apptabs_slug($label));
            if (isset($seen[$k])) {
                $errors[] = ['index' => $i, 'field' => 'label', 'message' => 'Another tab already uses that label.'];
            }
            $seen[$k] = true;
        }
        $err = apptabs_validate_url($t['url'] ?? null);
        if ($err !== null) {
            $errors[] = ['index' => $i, 'field' => 'url', 'message' => $err];
        }
        $open = $t['open'] ?? null;
        if ($open !== 'iframe' && $open !== 'newtab') {
            $errors[] = ['index' => $i, 'field' => 'open', 'message' => 'Choose how to open the app.'];
        }
        if (!is_bool($t['enabled'] ?? null)) {
            $errors[] = ['index' => $i, 'field' => 'enabled', 'message' => 'Enabled must be true or false.'];
        }
        $out[] = ['label' => $label, 'url' => $t['url'] ?? null, 'open' => $open, 'enabled' => $t['enabled'] ?? null];
    }
    return $errors === [] ? [$out, []] : [null, $errors];
}

/**
 * Load tabs.json. A missing file is an empty list. A file that exists but does not validate is an ERROR, never an
 * empty list: the caller must show it and must not overwrite the file.
 * @return array{tabs: array, error: ?string, exists: bool}
 */
function apptabs_load(): array
{
    $path = apptabs_config_path();
    if (!is_file($path)) {
        return ['tabs' => [], 'error' => null, 'exists' => false];
    }
    $fail = fn(string $why) => ['tabs' => [], 'error' => "$path is not usable ($why). No tabs are generated until it loads. Fix or remove that file by hand (a copy of the last good save may be at $path.bak).", 'exists' => true];
    $raw = @file_get_contents($path);
    if ($raw === false) {
        return $fail('cannot be read');
    }
    $d = json_decode($raw, true);
    if (!is_array($d) || ($d['version'] ?? null) !== 1 || !array_key_exists('tabs', $d)) {
        return $fail('not a version 1 App Tabs file');
    }
    [$tabs, $errs] = apptabs_normalize($d['tabs']);
    if ($tabs === null) {
        $e = $errs[0];
        return $fail('tab ' . ($e['index'] + 1) . ' ' . $e['field'] . ': ' . $e['message']);
    }
    return ['tabs' => $tabs, 'error' => null, 'exists' => true];
}

/** Write via a temp file in the same directory and rename, so a reader never sees a half-written file. */
function apptabs_atomic_write(string $path, string $data): bool
{
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $data, LOCK_EX) === false) {
        @unlink($tmp);
        return false;
    }
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/**
 * Validate, persist (keeping the previous good file as tabs.json.bak) and regenerate the pages.
 * @return array{0: bool, 1: string}
 */
function apptabs_save(array $tabs): array
{
    return apptabs_locked(fn() => apptabs_save_unlocked($tabs));
}

/**
 * Serialise every save and generation (web requests, the boot hook): one reader-modify-write at a time. The lock file
 * lives in the RAM temp dir, never on flash. If the lock cannot be taken the work still runs (a lock problem must not
 * take the settings page down).
 */
function apptabs_locked(callable $fn): mixed
{
    $fh = @fopen(sys_get_temp_dir() . '/app.tabs.' . md5(apptabs_config_dir()) . '.lock', 'c');
    if ($fh !== false) {
        @flock($fh, LOCK_EX);
    }
    try {
        return $fn();
    } finally {
        if ($fh !== false) {
            @flock($fh, LOCK_UN);
            fclose($fh);
        }
    }
}

function apptabs_save_unlocked(array $tabs): array
{
    $cur = apptabs_load();
    if ($cur['error'] !== null) {
        return [false, 'Not saved: ' . $cur['error']];
    }
    [$list, $errs] = apptabs_normalize($tabs);
    if ($list === null) {
        return [false, 'Not saved: ' . $errs[0]['message']];
    }
    // A label whose file name collides with a page we did not generate is refused BEFORE anything is written, so a
    // refused save changes neither tabs.json nor the pages on disk.
    foreach ($list as $t) {
        $f = apptabs_pages_dir() . '/AppTab-' . apptabs_slug($t['label']) . '.page';
        if ($t['enabled'] && is_file($f) && !str_contains((string) @file_get_contents($f), APPTABS_MARKER)) {
            return [false, 'Not saved: ' . basename($f) . ' already exists and was not generated by App Tabs. Choose a different label or remove that file.'];
        }
    }
    $dir = apptabs_config_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
        return [false, "Not saved: cannot create $dir"];
    }
    $path = apptabs_config_path();
    if ($cur['exists']) {
        $old = @file_get_contents($path);
        if ($old !== false) {
            apptabs_atomic_write($path . '.bak', $old);
        }
    }
    $json = json_encode(['version' => 1, 'tabs' => $list], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
    if (!apptabs_atomic_write($path, $json)) {
        return [false, "Not saved: cannot write $path"];
    }
    [$ok, $msg] = apptabs_generate_unlocked();
    return [$ok, $ok ? 'Saved.' : "Saved to $path, but generating the tab pages failed: $msg"];
}

/**
 * The text of one generated page. Every interpolated value is re-validated here, so even if validation upstream were
 * bypassed, nothing but a whitelisted slug, label and an integer can reach a file that PHP will later execute.
 */
function apptabs_page_text(string $slug, string $label, int $rank): string
{
    if (!preg_match('/\A[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\z/', $slug)) {
        throw new InvalidArgumentException('refusing to generate a page for an unsafe slug');
    }
    if (apptabs_validate_label($label) !== null || apptabs_slug($label) !== $slug) {
        throw new InvalidArgumentException('refusing to generate a page for an unsafe label');
    }
    if ($rank < 1 || $rank > 999) {
        throw new InvalidArgumentException('refusing to generate a page with that rank');
    }
    $plugin = dirname(__DIR__);
    if (!preg_match('~\A/[A-Za-z0-9/._-]+\z~', $plugin) || str_contains($plugin, '..')) {
        throw new InvalidArgumentException('refusing to generate a page for an unsafe plugin path');
    }
    return "Menu=\"Tasks:$rank\"\nTitle=\"$label\"\nName=\"$label\"\nCode=\"e911\"\nTabs=\"false\"\nMarkdown=\"false\"\n---\n"
        . "<?php /* " . APPTABS_MARKER . ": rewritten from tabs.json, do not edit */ require_once '$plugin/include/tabpage.php'; apptabs_render_tab('$slug'); ?>\n";
}

/** Paths of generated pages currently on disk: AppTab-*.page that carry the marker (nothing else is ever touched). */
function apptabs_generated_files(): array
{
    $out = [];
    foreach (glob(apptabs_pages_dir() . '/AppTab-*.page') ?: [] as $f) {
        $head = (string) @file_get_contents($f);
        if (str_contains($head, APPTABS_MARKER)) {
            $out[] = $f;
        }
    }
    sort($out);
    return $out;
}

/**
 * Make the pages on disk match tabs.json: one per enabled tab, ranked 93+ in the user's order; everything else we
 * generated before is removed. A config that does not load removes ALL generated pages and reports why.
 * @return array{0: bool, 1: string, 2: list<string>}
 */
function apptabs_generate(): array
{
    return apptabs_locked(fn() => apptabs_generate_unlocked());
}

function apptabs_generate_unlocked(): array
{
    $dir = apptabs_pages_dir();
    $cfg = apptabs_load();
    $want = [];
    if ($cfg['error'] === null) {
        $rank = APPTABS_FIRST_RANK;
        foreach ($cfg['tabs'] as $t) {
            if (!$t['enabled']) {
                continue;
            }
            $slug = apptabs_slug($t['label']);
            try {
                $want["$dir/AppTab-$slug.page"] = apptabs_page_text($slug, $t['label'], $rank++);
            } catch (\Throwable $e) {
                $want = [];
                $cfg['error'] = 'Could not generate a page: ' . $e->getMessage();
                break;
            }
        }
    }
    // A target that already exists but is not one of ours is never overwritten.
    if ($cfg['error'] === null) {
        foreach (array_keys($want) as $f) {
            if (is_file($f) && !str_contains((string) @file_get_contents($f), APPTABS_MARKER)) {
                $want = [];
                $cfg['error'] = 'Refusing to overwrite ' . basename($f) . ': it exists and was not generated by App Tabs. Rename the tab or remove that file.';
                break;
            }
        }
    }
    $stuck = [];
    foreach (apptabs_generated_files() as $f) {
        if (!isset($want[$f]) && !@unlink($f) && is_file($f)) {
            $stuck[] = basename($f);
        }
    }
    if ($cfg['error'] !== null) {
        return [false, $cfg['error'], []];
    }
    if ($stuck !== []) {
        return [false, 'Could not remove ' . implode(', ', $stuck) . ' (permissions?); those tabs may still show in the top bar.', array_keys($want)];
    }
    foreach ($want as $f => $text) {
        if (@file_get_contents($f) !== $text && !apptabs_atomic_write($f, $text)) {
            return [false, "cannot write $f", array_keys($want)];
        }
    }
    return [true, count($want) . ' tab page(s) in place.', array_keys($want)];
}
