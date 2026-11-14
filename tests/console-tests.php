<?php
declare(strict_types=1);

// Console-tab tests. Included by tests/run.php (shares check(), checkEquals(), $tmp, $root). Runs real processes: a stand-in
// docker CLI and a fake ttyd (tests/stubs) so the lifecycle (one ttyd per tab, reuse, replace, stale socket, races,
// reaping) is exercised for real, without Docker, tmux or the real ttyd.

$vectors = json_decode((string) file_get_contents("$root/tests/vectors.json"), true);

function ctab(array $o = []): array
{
    return $o + ['label' => 'Claude', 'kind' => 'console', 'container' => 'claude-code', 'session' => 'claude', 'shell' => 'sh', 'enabled' => true];
}

// ---- identifier and shell rules: the shared vectors, through PHP ---------------------------------------------------------
foreach ($vectors['identifiers_ok'] as $v) {
    check('identifier ok: ' . json_encode($v), apptabs_is_identifier($v) && apptabs_validate_container($v) === null && apptabs_validate_session($v) === null);
}
foreach ($vectors['identifiers_bad'] as $v) {
    check('identifier bad: ' . json_encode($v), !apptabs_is_identifier($v) && apptabs_validate_container($v) !== null && ($v === '' || apptabs_validate_session($v) !== null));
}
check('container: empty and non-string refused', apptabs_validate_container('') !== null && apptabs_validate_container(null) !== null && apptabs_validate_container(5) !== null);
check('session: empty is allowed (a shell is opened), null and non-strings are not', apptabs_validate_session('') === null && apptabs_validate_session(null) !== null && apptabs_validate_session(['a']) !== null);
check('identifier: a trailing newline is not smuggled past the anchor', !apptabs_is_identifier("claude\n"));
foreach ($vectors['shells_ok'] as $v) {
    check("shell ok: $v", apptabs_validate_shell($v) === null);
}
foreach ($vectors['shells_bad'] as $v) {
    check('shell bad: ' . json_encode($v), apptabs_validate_shell($v) !== null);
}

// ---- normalize ------------------------------------------------------------------------------------------------------
[$n, $e] = apptabs_normalize([['label' => 'Backrest', 'url' => 'http://[HOST]:9898/', 'open' => 'iframe', 'enabled' => true]]);
checkEquals('normalize: a tab without a kind is a URL tab', ['label' => 'Backrest', 'kind' => 'url', 'url' => 'http://[HOST]:9898/', 'open' => 'iframe', 'enabled' => true], $n[0] ?? null);
[$n, $e] = apptabs_normalize([['label' => 'Claude', 'kind' => null, 'url' => 'http://x/', 'open' => 'iframe', 'enabled' => true]]);
check('normalize: a null kind is a URL tab (same as absent)', $e === [] && $n[0]['kind'] === 'url');
[$n, $e] = apptabs_normalize([['label' => 'Claude', 'kind' => 'console', 'container' => 'claude-code', 'enabled' => true]]);
checkEquals('normalize: a console tab defaults session to empty and shell to sh', ['label' => 'Claude', 'kind' => 'console', 'container' => 'claude-code', 'session' => '', 'shell' => 'sh', 'enabled' => true], $n[0] ?? null);
[$n, $e] = apptabs_normalize([ctab(['url' => 'javascript:alert(1)', 'open' => 'x', 'extra' => 1])]);
checkEquals('normalize: URL keys and unknown keys on a console tab are dropped', ['label', 'kind', 'container', 'session', 'shell', 'enabled'], array_keys($n[0] ?? []));
[$n, $e] = apptabs_normalize([['label' => 'B', 'url' => 'http://x/', 'open' => 'iframe', 'enabled' => true, 'container' => 'a;b']]);
check('normalize: console keys on a URL tab are dropped', $e === [] && !array_key_exists('container', $n[0]));
foreach ([['container', ctab(['container' => 'a;b'])], ['container', ctab(['container' => ''])], ['container', ctab(['container' => null])], ['session', ctab(['session' => '$(x)'])],
    ['session', ctab(['session' => 'a b'])], ['session', ctab(['session' => '-t'])], ['shell', ctab(['shell' => 'zsh'])], ['kind', ctab(['kind' => 'terminal'])]] as [$field, $t]) {
    [$n, $e] = apptabs_normalize([$t]);
    check("normalize: refuses a bad $field (" . json_encode($t[$field] ?? null) . ')', $n === null && $e[0]['field'] === $field);
}
[$n, $e] = apptabs_normalize([ctab(), ctab(['label' => 'claude'])]);
check('normalize: a URL tab and a console tab share one label/slug namespace', $n === null && $e[0]['field'] === 'label');
[$n, $e] = apptabs_normalize([tab(['label' => 'Claude']), ctab()]);
check('normalize: a URL tab and a console tab cannot share a label', $n === null);
[$n, $e] = apptabs_normalize(array_map(fn($i) => $i % 2 ? ctab(['label' => "C$i"]) : tab(['label' => "U$i"]), range(0, 11)));
check('normalize: 12 mixed tabs fit', $n !== null && count($n) === 12);
[$n, $e] = apptabs_normalize(array_map(fn($i) => ctab(['label' => "C$i"]), range(0, 12)));
check('normalize: 13 tabs are refused whatever the kind', $n === null && $e[0]['index'] === -1);

// ---- the config file: version choice, old and new files ------------------------------------------------------------------
clean_dirs();
$goldenV1 = "{\n    \"version\": 1,\n    \"tabs\": [\n        {\n            \"label\": \"Backrest\",\n            \"url\": \"http://[HOST]:9898/\",\n            \"open\": \"iframe\",\n            \"enabled\": true\n        }\n    ]\n}\n";
file_put_contents("$tmp/cfg/tabs.json", $goldenV1);
$cfg = apptabs_load();
check('load: a file written by 0.1.x loads unchanged', $cfg['error'] === null && count($cfg['tabs']) === 1 && $cfg['tabs'][0]['kind'] === 'url' && $cfg['tabs'][0]['label'] === 'Backrest');
[$ok] = apptabs_save([tab()]);
check('save: a URL-only list saves', $ok);
checkEquals('save: a URL-only list is written byte-for-byte as 0.1.x wrote it (version 1, four keys, no kind)', $goldenV1, (string) file_get_contents("$tmp/cfg/tabs.json"));
[$ok, $msg] = apptabs_save([tab(), ctab()]);
check("save: a mixed list saves ($msg)", $ok);
$j = json_decode((string) file_get_contents("$tmp/cfg/tabs.json"), true);
checkEquals('save: a list with a console tab is written as version 2', 2, $j['version']);
checkEquals('save: version 2 gives every tab an explicit kind', ['url', 'console'], array_column($j['tabs'], 'kind'));
checkEquals('save: the console tab keeps exactly its own keys', ['label', 'kind', 'container', 'session', 'shell', 'enabled'], array_keys($j['tabs'][1]));
checkEquals('save: the previous good file is kept as tabs.json.bak', $goldenV1, (string) file_get_contents("$tmp/cfg/tabs.json.bak"));
$cfg = apptabs_load();
check('load: the version 2 file round-trips', $cfg['error'] === null && $cfg['tabs'][1]['kind'] === 'console' && $cfg['tabs'][1]['container'] === 'claude-code' && $cfg['tabs'][1]['session'] === 'claude');
[$ok] = apptabs_save([tab()]);
checkEquals('save: removing the last console tab goes back to the exact 0.1.x file', $goldenV1, (string) file_get_contents("$tmp/cfg/tabs.json"));
foreach (['v1 file holding a console tab' => json_encode(['version' => 1, 'tabs' => [ctab()]]), 'version 3' => json_encode(['version' => 3, 'tabs' => []]),
    'version "2" as a string' => json_encode(['version' => '2', 'tabs' => []]), 'v2 with a hostile container' => json_encode(['version' => 2, 'tabs' => [ctab(['container' => 'a;b'])]]),
    'v2 with an unknown kind' => json_encode(['version' => 2, 'tabs' => [ctab(['kind' => 'x'])]])] as $why => $body) {
    file_put_contents("$tmp/cfg/tabs.json", $body);
    $cfg = apptabs_load();
    check("load: $why is an error, never an empty list", $cfg['error'] !== null && $cfg['tabs'] === [] && $cfg['exists']);
}
file_put_contents("$tmp/cfg/tabs.json", json_encode(['version' => 2, 'tabs' => [tab(['kind' => 'url']), ctab(['session' => ''])]]));
$cfg = apptabs_load();
check('load: a version 2 file with an explicit URL kind and an empty session loads', $cfg['error'] === null && $cfg['tabs'][0]['kind'] === 'url' && $cfg['tabs'][1]['session'] === '');

// The real 0.1.1 loader (tests/fixtures/tabs-0.1.1.php is a byte copy of plugin/include/tabs.php at d11150a), in a subprocess.
$oldRun = function (string $php) use ($tmp): array {
    $boot = "$tmp/old-" . bin2hex(random_bytes(3)) . '.php';
    file_put_contents($boot, "<?php\nrequire " . var_export(__DIR__ . '/fixtures/tabs-0.1.1.php', true) . ";\n$php\n");
    $o = [];
    exec('APPTABS_CONFIG_DIR=' . escapeshellarg("$tmp/cfg") . ' APPTABS_PAGES_DIR=' . escapeshellarg("$tmp/pages") . ' php ' . escapeshellarg($boot) . ' 2>&1', $o, $rc);
    unlink($boot);
    return [$rc, json_decode(implode("\n", $o), true), implode("\n", $o)];
};
[$ok] = apptabs_save([tab(), ctab()]);
$v2 = (string) file_get_contents("$tmp/cfg/tabs.json");
[$rc, $r] = $oldRun('echo json_encode(apptabs_load());');
check('old 0.1.1 loader REFUSES a version 2 file (error, no tabs), rather than loading a console entry', $rc === 0 && is_array($r) && $r['error'] !== null && $r['tabs'] === [] && str_contains($r['error'], 'not a version 1'));
[$rc, $r] = $oldRun('[$ok, $m] = apptabs_save([["label"=>"X","url"=>"http://x/","open"=>"iframe","enabled"=>true]]); echo json_encode([$ok, $m]);');
check('old 0.1.1 save refuses to overwrite a version 2 file', $rc === 0 && $r[0] === false);
checkEquals('...and leaves the version 2 file byte-identical', $v2, (string) file_get_contents("$tmp/cfg/tabs.json"));
clean_dirs();
[$ok] = apptabs_save([tab(['label' => 'Plex']), tab()]);
[$rc, $r] = $oldRun('echo json_encode(apptabs_load());');
check('old 0.1.1 loader loads what this version writes for URL-only lists (downgrade is safe)', $rc === 0 && $r['error'] === null && array_column($r['tabs'], 'label') === ['Plex', 'Backrest']);

// ---- command construction ---------------------------------------------------------------------------------------------
$D = '/usr/bin/docker';
$bash = apptabs_find_bin('bash', 'APPTABS_BASH') ?? '/bin/bash';
$script = "$root/plugin/scripts/console-attach.sh";
checkEquals('command: tmux session (wrapper script, docker, container, session, shell normalised to sh)', [$bash, $script, $D, 'claude-code', 'claude', 'sh'], apptabs_console_command(ctab(['shell' => 'bash']), $D));
checkEquals('command: empty session opens the chosen shell', [$bash, $script, $D, 'claude-code', '', 'bash'], apptabs_console_command(ctab(['session' => '', 'shell' => 'bash']), $D));
checkEquals('command: shell defaults to sh', [$bash, $script, $D, 'c1', '', 'sh'], apptabs_console_command(['container' => 'c1'], $D));
check('command: the wrapper script ships in the plugin tree and is executable', is_file($script) && is_executable($script));
foreach (['a;b', '$(x)', '`id`', 'a b', '-rf', '--help', '.hidden', '..', '', "a\nb", 'ünï', str_repeat('a', 129), 'a|b', 'a&&b', "a\0b", '=x'] as $bad) {
    foreach (['container' => ctab(['container' => $bad]), 'session' => ctab(['session' => $bad === '' ? 'x y' : $bad])] as $field => $t) {
        $threw = false;
        try {
            apptabs_console_command($t, $D);
        } catch (InvalidArgumentException $e) {
            $threw = true;
        }
        check("command: a bypassed validator ($field " . json_encode($bad) . ') cannot build a command', $threw);
    }
}
$threw = false;
try {
    apptabs_console_command(ctab(['session' => '', 'shell' => 'sh;id']), $D);
} catch (InvalidArgumentException $e) {
    $threw = true;
}
check('command: a shell outside the sh/bash whitelist cannot build a command', $threw);
foreach (array_slice(apptabs_console_command(ctab(['container' => 'a.b-c_d', 'session' => 'x.y-z_1']), $D), 3) as $el) {
    check("command: no user-derived argv element carries a shell metacharacter ($el)", !preg_match('/[\s;&|$`"\'<>()\\\\*?\[\]{}~!#]/', $el));
}
$code = '';
foreach (token_get_all((string) file_get_contents("$root/plugin/include/console.php")) as $tok) {
    if (is_array($tok) ? !in_array($tok[0], [T_COMMENT, T_DOC_COMMENT], true) : true) {
        $code .= is_array($tok) ? $tok[1] : $tok;
    }
}
check('console.php never builds a command string (no exec/shell_exec/system/passthru/popen/backticks in code)', !preg_match('/\b(exec|shell_exec|system|passthru|popen|pcntl_exec)\s*\(|`/', $code));
check('console.php only uses proc_open with the argv array parameter of apptabs_run()', preg_match_all('/proc_open\(\s*(\$\w+)\s*,/', $code, $m) === 1 && $m[1][0] === '$cmd');

// ---- the per-connection wrapper (console-attach.sh), run for real against the stand-in docker ---------------------------------
$wstub = "$tmp/wstub";
mkdir($wstub, 0777, true);
file_put_contents("$wstub/ps.txt", '');
file_put_contents("$wstub/sessions.txt", '');
$wrap = function (array $args, array $env = []) use ($wstub, $root, $script, $bash): array {
    $p = proc_open(array_merge([$bash, $script, "$root/tests/stubs/docker"], $args), [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null,
        $env + ['PATH' => getenv('PATH'), 'APPTABS_STUB_DIR' => $wstub]);
    return [$p, $pipes];
};
$wlog = fn(): string => (string) @file_get_contents("$wstub/docker.log");
$waitFor = function (callable $f, float $secs = 6.0): bool {
    $u = microtime(true) + $secs;
    while (microtime(true) < $u) {
        if ($f()) {
            return true;
        }
        usleep(50000);
    }
    return false;
};
function gone(int $pid): bool
{
    $st = @file_get_contents("/proc/$pid/stat");
    return !is_dir("/proc/$pid") || ($st !== false && preg_match('/\) Z /', $st) === 1);
}
foreach ([['a;b', 's', 'sh'], ['$(x)', 's', 'sh'], ['-x', 's', 'sh'], ['c', 'a b', 'sh'], ['c', '-t', 'sh'], ['c', '', 'zsh'], ['c', '', ''], ['', '', 'sh'], ["c\n", 's', 'sh'], [str_repeat('a', 129), 's', 'sh']] as $args) {
    @unlink("$wstub/docker.log");
    [$p, $pp] = $wrap($args);
    $err = stream_get_contents($pp[2]);
    $rc = proc_close($p);
    check('wrapper: refuses ' . json_encode($args) . " with exit 64 and no docker call (rc $rc)", $rc === 64 && $wlog() === '' && str_contains($err, 'refusing'));
}
$p = proc_open([$bash, $script, '/nonexistent-docker-binary', 'c', 's', 'sh'], [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pp, null, ['PATH' => getenv('PATH')]);
check('wrapper: a docker path that is not executable is refused (exit 64)', proc_close($p) === 64);
// a normal connection, then the connection dies (SIGHUP, what ttyd sends): the tagged container-side process must be ended
@unlink("$wstub/docker.log");
@unlink("$wstub/attach.pid");
$decoy = proc_open(['sleep', '30'], [], $dd);   // an unrelated process: must survive the cleanup
[$p, $pp] = $wrap(['claude-code', 'claude', 'sh']);
$st = proc_get_status($p);
$up = $waitFor(fn() => is_file("$wstub/attach.pid") && str_contains($wlog(), 'exec -it -e APPTABS_CONN='));
check('wrapper: runs docker exec -it -e APPTABS_CONN=<id> <container> tmux attach-session -t =<session>', $up && preg_match('/^exec -it -e APPTABS_CONN=([0-9a-f-]{20,}) claude-code tmux attach-session -t =claude$/m', $wlog(), $m) === 1);
$id = $m[1] ?? '';
$tagged = (int) trim((string) @file_get_contents("$wstub/attach.pid"));
check('wrapper: the container-side process is up and carries the tag in its environment', $tagged > 1 && str_contains(str_replace("\0", "\n", (string) @file_get_contents("/proc/$tagged/environ")), "APPTABS_CONN=$id"));
exec('kill -HUP ' . (int) $st['pid']);
$done = $waitFor(fn() => !proc_get_status($p)['running']);
check('wrapper: SIGHUP (the connection ended) makes it clean up and exit', $done);
check('wrapper: ...it asked the container to end the tagged processes (same id)', preg_match('/^exec claude-code sh -c .* sh ' . preg_quote($id, '/') . '$/ms', $wlog()) === 1);
check('wrapper: ...and the tagged container-side process is gone', $waitFor(fn() => gone($tagged)));
check('wrapper: ...while an unrelated process was left alone', !gone(proc_get_status($decoy)['pid']));
proc_terminate($decoy, 9);
proc_close($decoy);
proc_close($p);
// a tmux server that inherited the tag (a shell tab started it) must outlive the tab: its comm is "tmux: server"
@unlink("$wstub/docker.log");
@unlink("$wstub/attach.pid");
copy((string) trim((string) shell_exec('command -v sleep')), "$wstub/tmux: server");   // comm comes from the executable's file name
chmod("$wstub/tmux: server", 0755);
[$p, $pp] = $wrap(['claude-code', '', 'sh'], ['STUB_ATTACH_BIN' => "$wstub/tmux: server"]);
$waitFor(fn() => is_file("$wstub/attach.pid") && str_contains($wlog(), 'exec -it'));
$srvPid = (int) trim((string) @file_get_contents("$wstub/attach.pid"));
check('wrapper: (setup) the tagged process now reports comm "tmux: server"', trim((string) @file_get_contents("/proc/$srvPid/comm")) === 'tmux: server');
exec('kill -HUP ' . (int) proc_get_status($p)['pid']);
$waitFor(fn() => !proc_get_status($p)['running']);
usleep(300000);
check('wrapper: a tagged "tmux: server" survives the cleanup', !gone($srvPid));
exec('kill -9 ' . $srvPid);
proc_close($p);
// each connection gets its own id
$ids = [];
for ($i = 0; $i < 2; $i++) {
    @unlink("$wstub/docker.log");
    [$p, $pp] = $wrap(['claude-code', '', 'bash'], ['STUB_ATTACH_SLEEP' => '1']);
    $waitFor(fn() => str_contains($wlog(), 'exec -it'));
    preg_match('/APPTABS_CONN=(\S+) claude-code bash$/m', $wlog(), $mm);
    $ids[] = $mm[1] ?? '';
    check('wrapper: an empty session runs the chosen shell, no tmux', str_contains($wlog(), ' claude-code bash') && !str_contains($wlog(), 'tmux'));
    proc_close($p);
}
check('wrapper: every connection has its own id', $ids[0] !== '' && $ids[1] !== '' && $ids[0] !== $ids[1]);
// a normal exit passes the exit status through and still runs the (no-op) cleanup
@unlink("$wstub/docker.log");
[$p, $pp] = $wrap(['claude-code', 'claude', 'sh'], ['STUB_ATTACH_SLEEP' => '0.2', 'STUB_ATTACH_RC' => '3']);
$rc = proc_close($p);
check('wrapper: a normal exit passes the status through (3) and still runs the cleanup', $rc === 3 && str_contains($wlog(), 'exec claude-code sh -c'));
$src = (string) file_get_contents($script);
check('wrapper: no eval, no command string, never `sh -c` with user data interpolated', !preg_match('/\beval\b/', $src) && substr_count($src, "sh -c '") === 1);

// ---- socket naming --------------------------------------------------------------------------------------------------------
checkEquals('sockname: prefixed with an underscore', '_apptabs-Claude', apptabs_console_sockname('Claude'));
check('sockname: can never equal a name Unraid or Docker would use (first char is not alphanumeric)', !preg_match('/\A[A-Za-z0-9]/', apptabs_console_sockname('claude-code')));
checkEquals('url: relative /logterminal/<name>/', '/logterminal/_apptabs-My-App/', apptabs_console_url('My-App'));
foreach (['', '../x', 'a/b', 'a b', '-a', 'a-', 'a--b', 'a.b', str_repeat('a', 65), "a\n"] as $bad) {
    $threw = false;
    try {
        apptabs_console_sockname($bad);
    } catch (InvalidArgumentException $e) {
        $threw = true;
    }
    check('sockname: unsafe slug refused: ' . json_encode($bad), $threw);
}
// the nginx location regex on this name (copied from /etc/nginx/conf.d/locations.conf)
check('url: matches nginx\'s /logterminal/(.*)/(.*)$ with the socket name as the first group', preg_match('~/logterminal/(.*)/(.*)$~', apptabs_console_url('Claude'), $m) === 1 && $m[1] === '_apptabs-Claude' && $m[2] === '');

// ---- page generation: a console tab still yields only the whitelisted label and slug ---------------------------------------
clean_dirs();
[$ok, $msg] = apptabs_save([tab(), ctab(['container' => 'secret-box', 'session' => 'sess-name'])]);
check("generate: mixed list generates ($msg)", $ok);
checkEquals('generate: one page per enabled tab', ['AppTab-Backrest.page', 'AppTab-Claude.page'], array_map('basename', glob("$tmp/pages/AppTab-*.page")));
$page = (string) file_get_contents("$tmp/pages/AppTab-Claude.page");
check('generate: the console page has the label, slug and rank', str_contains($page, 'Menu="Tasks:94"') && str_contains($page, 'Name="Claude"') && str_contains($page, "apptabs_render_tab('Claude')"));
check('generate: the console page carries neither container nor session', !str_contains($page, 'secret-box') && !str_contains($page, 'sess-name') && !str_contains($page, 'docker') && !str_contains($page, 'tmux'));
checkEquals('generate: the console page has exactly the same shape as a URL tab page', str_replace('Backrest', 'Claude', preg_replace('/Tasks:\d+/', 'Tasks:94', (string) file_get_contents("$tmp/pages/AppTab-Backrest.page"))), $page);
[$ok] = apptabs_save([tab(['enabled' => false]), ctab(['enabled' => false])]);
check('generate: disabled console tab has no page', glob("$tmp/pages/AppTab-*.page") === []);

// ---- lifecycle against the stand-ins --------------------------------------------------------------------------------------------
$stub = "$tmp/stub";
$socks = "$tmp/socks";
mkdir($stub, 0777, true);
@mkdir($socks, 0777, true);
file_put_contents("$stub/ps.txt", "claude-code|running\nclaude-code-old|running\nstopped-one|exited\nnamed.dot|running\n");
file_put_contents("$stub/sessions.txt", "claude\napptabs-test\n");
putenv("APPTABS_STUB_DIR=$stub");
putenv("APPTABS_DOCKER=$root/tests/stubs/docker");
putenv("APPTABS_TTYD_EXEC=$root/tests/stubs/ttyd-exec");
putenv("APPTABS_SOCK_DIR=$socks");
$pids = fn(string $slug): array => array_map(fn($p) => $p['pid'], apptabs_ttyd_procs("$socks/_apptabs-$slug.sock"));

[$ok, $msg, $url] = apptabs_console_prepare('Claude', ctab());
check("prepare: running container + existing session starts a ttyd ($msg)", $ok && $url === '/logterminal/_apptabs-Claude/' && apptabs_sock_alive("$socks/_apptabs-Claude.sock"));
$p1 = $pids('Claude');
checkEquals('prepare: exactly one ttyd for the tab', 1, count($p1));
$procs = apptabs_ttyd_procs("$socks/_apptabs-Claude.sock");
checkEquals('prepare: ttyd got the exact argv: ...-i <sock> bash <wrapper> <docker> claude-code claude sh', ["$socks/_apptabs-Claude.sock", $bash, $script, "$root/tests/stubs/docker", 'claude-code', 'claude', 'sh'], array_merge([$procs[0]['sock']], $procs[0]['tail']));
check('prepare: ttyd-exec got -s1 (SIGHUP on disconnect, so the wrapper can clean up), never -s9 or -o/-m', (string) file("$stub/ttyd-exec.log")[0] !== '' && str_starts_with(trim(file("$stub/ttyd-exec.log")[0]), '-s1 -i ') && !preg_match('/ -[om]\d?( |$)|-s9/', file("$stub/ttyd-exec.log")[0]));
for ($i = 0; $i < 6; $i++) {
    apptabs_console_prepare('Claude', ctab());
}
checkEquals('prepare: six more page loads reuse it (same pid, still one process)', $p1, $pids('Claude'));
checkEquals('prepare: ttyd-exec was only run once', 1, count(file("$stub/ttyd-exec.log")));

// two page loads at the same instant
$loader = "$tmp/loader.php";
file_put_contents($loader, "<?php\nrequire " . var_export("$root/plugin/include/tabs.php", true) . ";\n[\$ok, \$m] = apptabs_console_prepare('Race', " . var_export(ctab(['label' => 'Race']), true) . ");\necho \$ok ? 'ok' : \$m;\n");
$run = [];
for ($i = 0; $i < 5; $i++) {
    $run[$i] = proc_open(['php', $loader], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pp[$i], null, ['PATH' => getenv('PATH'), 'APPTABS_CONFIG_DIR' => "$tmp/cfg", 'APPTABS_STUB_DIR' => $stub, 'APPTABS_DOCKER' => "$root/tests/stubs/docker", 'APPTABS_TTYD_EXEC' => "$root/tests/stubs/ttyd-exec", 'APPTABS_SOCK_DIR' => $socks]);
}
$outs = [];
foreach ($run as $i => $r) {
    $outs[] = stream_get_contents($pp[$i][1]);
    proc_close($r);
}
checkEquals('race: five simultaneous page loads all succeed', array_fill(0, 5, 'ok'), $outs);
checkEquals('race: ...and leave exactly one ttyd for the tab', 1, count($pids('Race')));

// the tab is edited: the old ttyd must go, a new one with the new command takes over
[$ok] = apptabs_console_prepare('Claude', ctab(['session' => 'apptabs-test']));
$p2 = $pids('Claude');
check('edit: a changed session replaces the ttyd (one process, new pid)', $ok && count($p2) === 1 && $p2 !== $p1 && gone($p1[0]));
check('edit: ...with the new command', in_array('apptabs-test', apptabs_ttyd_procs("$socks/_apptabs-Claude.sock")[0]['tail'], true));

// a ttyd killed hard leaves its socket file behind: a file is not a server
exec('kill -9 ' . (int) $p2[0]);
usleep(200000);
check('stale: a killed ttyd leaves a socket file that does not accept connections', @filetype("$socks/_apptabs-Claude.sock") === 'socket' && !apptabs_sock_alive("$socks/_apptabs-Claude.sock"));
[$ok, $msg] = apptabs_console_prepare('Claude', ctab(['session' => 'apptabs-test']));
check("stale: the next page load replaces it ($msg)", $ok && apptabs_sock_alive("$socks/_apptabs-Claude.sock") && count($pids('Claude')) === 1);

// foreign processes are never touched
$sockC = "$socks/_apptabs-Claude.sock";
$decoys = [
    proc_open(['bash', '-c', "sleep 8; : ttyd -i $sockC"], [], $d1),                                        // the words only appear inside one argv element
    proc_open(['bash', '-c', 'exec -a notttyd php -r "sleep(8);" -- -i ' . escapeshellarg($sockC)], [], $d2), // exact -i pair, but not ttyd
    proc_open(['bash', '-c', 'exec -a ttyd php -r "sleep(8);" -- -i ' . escapeshellarg('/elsewhere/_apptabs-Claude.sock')], [], $d3), // ttyd, another directory
];
usleep(250000);
[$ok] = apptabs_console_prepare('Claude', ctab(['session' => 'claude']));
apptabs_console_reap([ctab(['session' => 'claude'])]);
check('foreign: lookalike processes survive an edit-restart and a reap', array_reduce($decoys, fn($c, $d) => $c && proc_get_status($d)['running'], true));
check('foreign: and the exact matcher for this socket reports only the real ttyd', count($pids('Claude')) === 1);
foreach ($decoys as $d) {
    proc_terminate($d, 9);
    proc_close($d);
}

// reap
[$ok] = apptabs_console_prepare('Claude', ctab(['session' => 'claude']));
check('reap: keeps a ttyd whose tab still matches', apptabs_console_reap([ctab(['session' => 'claude'])]) === 0 && count($pids('Claude')) === 1 && count($pids('Race')) === 0 /* stopped by the reap in the block above */);
check('reap: stops a ttyd whose session changed, and removes its socket', apptabs_console_reap([ctab(['session' => 'other'])]) === 1 && $pids('Claude') === [] && !file_exists("$socks/_apptabs-Claude.sock"));
apptabs_console_prepare('Claude', ctab());
check('reap: stops a ttyd whose tab is disabled', apptabs_console_reap([ctab(['enabled' => false])]) === 1 && $pids('Claude') === []);
apptabs_console_prepare('Claude', ctab());
check('reap: an empty list (plugin removal) stops everything', apptabs_console_reap([]) === 1 && $pids('Claude') === []);
apptabs_console_prepare('Claude', ctab());
[$ok] = apptabs_save([ctab(['session' => 'apptabs-test'])]);
check('reap: a save that edits the tab stops the stale ttyd (nothing is started by a save)', $pids('Claude') === []);
$ps = (string) shell_exec('php ' . escapeshellarg("$root/plugin/include/console-stop.php") . ' 2>&1');
check('console-stop.php runs, reports, and exits cleanly', str_contains($ps, 'stopped 0'));

// failure messages (each must leave no ttyd behind)
$before = count(file("$stub/ttyd-exec.log"));
foreach ([
    'stopped container' => [ctab(['container' => 'stopped-one']), 'not running'],
    'missing container' => [ctab(['container' => 'nope-not-here']), 'no Docker container named nope-not-here'],
    'substring of a real name is not a match' => [ctab(['container' => 'claude']), 'no Docker container named claude'],
    'missing session' => [ctab(['session' => 'ghost']), 'no tmux session named ghost'],
    'invalid container' => [ctab(['container' => 'a;b']), 'invalid'],
] as $why => [$t, $needle]) {
    [$ok, $msg, $url] = apptabs_console_prepare('Claude', $t);
    check("failure: $why gives a clear message and no iframe ($msg)", !$ok && $url === '' && str_contains($msg, $needle));
}
checkEquals('failure: none of them started a ttyd', $before, count(file("$stub/ttyd-exec.log")));
[$ok, $msg] = apptabs_console_prepare('Claude', ctab(['session' => '', 'shell' => 'bash']));
check("shell tab: no tmux check, starts the shell command ($msg)", $ok && in_array('bash', apptabs_ttyd_procs("$socks/_apptabs-Claude.sock")[0]['tail'], true));
apptabs_console_reap([]);
putenv("APPTABS_DOCKER=$tmp/no-such-docker");
[$ok, $msg] = apptabs_console_prepare('Claude', ctab());
check("failure: docker missing is reported ($msg)", !$ok && str_contains($msg, 'docker command was not found'));
file_put_contents("$tmp/bad-docker", "#!/bin/bash\necho 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' >&2\nexit 1\n");
chmod("$tmp/bad-docker", 0755);
putenv("APPTABS_DOCKER=$tmp/bad-docker");
[$ok, $msg] = apptabs_console_prepare('Claude', ctab());
check("failure: a Docker daemon that is down is reported ($msg)", !$ok && str_contains($msg, 'Docker did not answer') && str_contains($msg, 'Cannot connect'));
file_put_contents("$tmp/slow-docker", "#!/bin/bash\nsleep 30\n");
chmod("$tmp/slow-docker", 0755);
putenv("APPTABS_DOCKER=$tmp/slow-docker");
$t0 = microtime(true);
[$st, $err] = apptabs_container_state('x');
check('failure: a hung docker is cut off by the deadline, not waited for', $st === null && microtime(true) - $t0 < 10);
putenv("APPTABS_DOCKER=$root/tests/stubs/docker");
putenv("APPTABS_TTYD_EXEC=$tmp/no-such-ttyd-exec");
[$ok, $msg] = apptabs_console_prepare('Claude', ctab());
check("failure: a missing ttyd-exec is reported ($msg)", !$ok && str_contains($msg, 'ttyd-exec'));
putenv("APPTABS_TTYD_EXEC=$root/tests/stubs/ttyd-exec");
putenv('FAKE_TTYD_NO_SOCKET=1');
$t0 = microtime(true);
[$ok, $msg] = apptabs_console_prepare('Claude', ctab());
$dt = microtime(true) - $t0;
check("failure: a ttyd that never listens times out within the bound with a message ($msg, " . round($dt, 1) . 's)', !$ok && str_contains($msg, 'did not start') && $dt < 6);
putenv('FAKE_TTYD_NO_SOCKET');
foreach (apptabs_ttyd_procs() as $p) {
    apptabs_kill_pid($p['pid']);
}
@unlink("$socks/_apptabs-Claude.sock");
check('cleanup: no test ttyd left running', apptabs_ttyd_procs() === []);
putenv('APPTABS_STUB_DIR');
putenv('APPTABS_DOCKER');
putenv('APPTABS_TTYD_EXEC');
putenv('APPTABS_SOCK_DIR');
