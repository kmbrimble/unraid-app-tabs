<?php
/**
 * App Tabs Docker console: the host-side ttyd behind a "console" tab.
 *
 * A console tab shows `docker exec -it <container> tmux attach -t =<session>` (or a shell) in an iframe. The terminal
 * server is the HOST's own ttyd (the one Unraid's Docker "Console" and webGUI terminal use), started through Unraid's
 * /usr/local/sbin/ttyd-exec on a root-only unix socket under /var/tmp. nginx proxies /logterminal/<name>/ to that
 * socket behind the webGUI login (auth_request), so there is no password, token or port anywhere, and nothing runs
 * inside the container.
 *
 * Loaded only by tabs.php (do not require it directly). Runs under php-fpm AND the CLI test harness: no CLI-only constructs.
 *
 * Trust model: container, session and shell come from tabs.json and are re-validated here, at the point of use, so a
 * bypassed validator upstream still cannot reach a command. Nothing is ever passed through a shell: every command is an
 * argv array (proc_open takes the array form, which does not involve /bin/sh), and the one wrapper script (ttyd-exec)
 * receives its arguments as plain argv, exactly as Unraid's own launcher passes them.
 *
 * Disconnects: `docker exec -it` leaves its process in the container when the client goes away (no signal to the docker
 * CLI changes that), so ttyd runs plugin/scripts/console-attach.sh, which tags each connection and has the container end
 * the tagged processes when the connection closes. Without it every closed browser tab would leave a stray tmux client.
 *
 * Lifecycle (a deliberate difference from Unraid's launcher, which uses `-om1`): ttyd here is started WITHOUT -o and
 * -m, so one ttyd per tab stays up and serves every connection (each connection runs its own `docker exec`). A page
 * reload, a reconnect, a second window or two quick loads therefore never race a dying one-shot process, and the tab can
 * be revisited forever without a new process each time. Exactly one ttyd per tab socket is enforced, under a per-tab
 * lock, and it is replaced only when its command no longer matches the tab (container or session edited). It is started
 * only when the tab page is loaded (never at install or boot) and stopped when the tab is removed, edited or the plugin
 * is removed.
 */

declare(strict_types=1);

/** nginx's /logterminal/(.*)/(.*) maps the first group to /var/tmp/<group>.sock. */
const APPTABS_SOCK_PREFIX = '_apptabs-';

function apptabs_sock_dir(): string
{
    return rtrim(apptabs_env('APPTABS_SOCK_DIR', '/var/tmp'), '/');
}

/**
 * Socket name for a tab. The leading underscore is the point: every other socket in /var/tmp is named after a Docker
 * container, a disk or a log, and all of those begin with a letter or digit (OpenTerminal.php's identifier rules), so
 * this name cannot collide with, or be used to reach, one of them.
 */
function apptabs_console_sockname(string $slug): string
{
    if (!preg_match('/\A[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\z/', $slug) || strlen($slug) > 64) {
        throw new InvalidArgumentException('refusing to build a console socket for an unsafe slug');
    }
    return APPTABS_SOCK_PREFIX . $slug;
}

function apptabs_console_sockpath(string $slug): string
{
    return apptabs_sock_dir() . '/' . apptabs_console_sockname($slug) . '.sock';
}

/** Relative, so it works for whatever hostname and port the GUI was opened with. */
function apptabs_console_url(string $slug): string
{
    return '/logterminal/' . apptabs_console_sockname($slug) . '/';
}

/** First executable named $name on a fixed set of directories (php-fpm's PATH is not trusted to contain them). */
function apptabs_find_bin(string $name, string $override): ?string
{
    $o = apptabs_env($override, '');
    if ($o !== '') {
        return is_executable($o) ? $o : null;
    }
    foreach (['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'] as $d) {
        if (is_executable("$d/$name")) {
            return "$d/$name";
        }
    }
    return null;
}

/** The per-connection wrapper (plugin/scripts/console-attach.sh); see its header for why it exists. */
function apptabs_console_script(): string
{
    return dirname(__DIR__) . '/scripts/console-attach.sh';
}

/**
 * The command ttyd runs for each connection, as an argv array: [bash, wrapper script, docker, container, session, shell].
 * The wrapper builds the actual `docker exec -it` itself. Re-validates everything; throws on anything a bypassed validator
 * might let through. The shell only matters when there is no session, so it is normalised away otherwise (editing it on a
 * tmux tab must not restart anything).
 * @return list<string>
 */
function apptabs_console_command(array $tab, string $docker): array
{
    $container = $tab['container'] ?? null;
    $session = $tab['session'] ?? '';
    $shell = $tab['shell'] ?? 'sh';
    if (apptabs_validate_container($container) !== null || apptabs_validate_session($session) !== null || apptabs_validate_shell($shell) !== null) {
        throw new InvalidArgumentException('refusing to build a console command from an invalid container, session or shell');
    }
    $bash = apptabs_find_bin('bash', 'APPTABS_BASH') ?? '/bin/bash';
    return [$bash, apptabs_console_script(), $docker, $container, $session, $session !== '' ? 'sh' : $shell];
}

/**
 * Run an argv without a shell, with a deadline. Never throws.
 * @return array{0: ?int, 1: string, 2: string} exit code (null: could not start or timed out), stdout, stderr
 */
function apptabs_run(array $cmd, float $timeout = 6.0): array
{
    $proc = @proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) {
        return [null, '', 'could not start ' . basename((string) ($cmd[0] ?? ''))];
    }
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $out = $err = '';
    $code = null;
    $deadline = microtime(true) + $timeout;
    while (true) {
        $out .= (string) stream_get_contents($pipes[1]);
        $err .= (string) stream_get_contents($pipes[2]);
        $st = proc_get_status($proc);
        if (!$st['running']) {
            $code = $st['exitcode'];
            $out .= (string) stream_get_contents($pipes[1]);
            $err .= (string) stream_get_contents($pipes[2]);
            break;
        }
        if (microtime(true) > $deadline) {
            proc_terminate($proc, 9);
            $err .= 'timed out';
            break;
        }
        usleep(20000);
    }
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($proc);
    return [$code === -1 ? null : $code, $out, $err];
}

/**
 * State of a container by exact name: ['missing'|'running'|<other docker state>], or null plus an error when Docker
 * cannot be asked. `docker ps --filter name=` is a substring match, so list everything and compare names exactly.
 * @return array{0: ?string, 1: ?string}
 */
function apptabs_container_state(string $container): array
{
    $docker = apptabs_find_bin('docker', 'APPTABS_DOCKER');
    if ($docker === null) {
        return [null, 'The docker command was not found on this server.'];
    }
    [$rc, $out, $err] = apptabs_run([$docker, 'ps', '-a', '--no-trunc', '--format', '{{.Names}}|{{.State}}']);
    if ($rc !== 0) {
        return [null, 'Docker did not answer (is the Docker service running?)' . apptabs_first_line($err)];
    }
    foreach (preg_split('/\R/', trim($out)) ?: [] as $line) {
        [$name, $state] = array_pad(explode('|', $line, 2), 2, '');
        if ($name === $container) {
            return [$state, null];
        }
    }
    return ['missing', null];
}

function apptabs_first_line(string $s): string
{
    $l = trim((string) strtok(preg_replace('/[^\x20-\x7e\n]/', '', $s) ?? '', "\n"));
    return $l === '' ? '' : ' (' . substr($l, 0, 160) . ')';
}

/**
 * Processes that are a ttyd serving exactly this socket. Matches the executable name and the socket as an exact argv
 * element pair ("-i", <path>) in /proc/<pid>/cmdline: never a substring of a command line (`pgrep -f` also matches the
 * agent, ssh and shell processes that merely mention ttyd).
 * @return list<array{pid: int, argv: list<string>}>
 */
function apptabs_ttyd_procs(?string $sock = null): array
{
    $out = [];
    foreach (glob('/proc/[0-9]*/cmdline') ?: [] as $f) {
        $raw = @file_get_contents($f);
        if ($raw === false || $raw === '') {
            continue;
        }
        $args = explode("\0", rtrim($raw, "\0"));
        // argv[0] is ttyd itself (/usr/bin/ttyd); the second slot is allowed so an interpreter-run stand-in works in tests.
        if (basename($args[0]) !== 'ttyd' && basename($args[1] ?? '') !== 'ttyd') {
            continue;
        }
        $at = array_search('-i', $args, true);
        if ($at === false || !isset($args[$at + 1])) {
            continue;
        }
        if (($sock === null && !str_starts_with(basename($args[$at + 1]), APPTABS_SOCK_PREFIX)) || ($sock !== null && $args[$at + 1] !== $sock)) {
            continue;
        }
        $out[] = ['pid' => (int) basename(dirname($f)), 'argv' => $args, 'sock' => $args[$at + 1], 'tail' => array_slice($args, $at + 2)];
    }
    return $out;
}

function apptabs_kill_pid(int $pid): void
{
    if ($pid < 2) {
        return;
    }
    foreach ([[15, 1.5], [9, 1.0]] as [$sig, $wait]) {
        if (function_exists('posix_kill')) {
            @posix_kill($pid, $sig);
        } else {
            apptabs_run(['kill', '-' . $sig, (string) $pid], 2.0);
        }
        $until = microtime(true) + $wait;
        while (microtime(true) < $until) {
            if (!is_dir("/proc/$pid")) {
                return;
            }
            usleep(25000);
            // a zombie awaiting its parent no longer serves anything
            $st = @file_get_contents("/proc/$pid/stat");
            if ($st !== false && preg_match('/\) Z /', $st)) {
                return;
            }
        }
    }
}

/** Remove a socket file left by a ttyd that died without cleaning up. Only ever a unix socket, never a symlink or file. */
function apptabs_drop_stale_socket(string $sock): void
{
    clearstatcache(true, $sock);
    if (!is_link($sock) && @filetype($sock) === 'socket') {
        @unlink($sock);
    }
}

/** A real connection, not just a file: a dead ttyd leaves its socket file behind. */
function apptabs_sock_alive(string $sock): bool
{
    clearstatcache(true, $sock);
    if (@filetype($sock) !== 'socket') {
        return false;
    }
    $c = @stream_socket_client('unix://' . $sock, $errno, $errstr, 0.5);
    if ($c === false) {
        return false;
    }
    fclose($c);
    return true;
}

function apptabs_wait_alive(string $sock, float $seconds): bool
{
    $until = microtime(true) + $seconds;
    do {
        if (apptabs_sock_alive($sock)) {
            return true;
        }
        usleep(50000);
    } while (microtime(true) < $until);
    return false;
}

/**
 * Make sure exactly one ttyd with the right command serves this tab's socket. Serialised per socket, so two quick page
 * loads (or a load racing a save) cannot interleave the find/kill/start steps.
 * @return array{0: bool, 1: string} ok, message when not ok
 */
function apptabs_console_ensure_ttyd(string $slug, array $tab): array
{
    try {
        $sock = apptabs_console_sockpath($slug);
    } catch (InvalidArgumentException $e) {
        return [false, 'This console tab has an invalid setting and was not started: ' . $e->getMessage()];
    }
    $docker = apptabs_find_bin('docker', 'APPTABS_DOCKER');
    $ttydExec = apptabs_find_bin('ttyd-exec', 'APPTABS_TTYD_EXEC');
    if ($docker === null) {
        return [false, 'The docker command was not found on this server.'];
    }
    try {
        $want = apptabs_console_command($tab, $docker);
    } catch (InvalidArgumentException $e) {
        return [false, 'This console tab has an invalid setting and was not started: ' . $e->getMessage()];
    }
    if (!is_file($want[1])) {
        return [false, 'The App Tabs console helper script is missing from the plugin (' . basename($want[1]) . '). Reinstall the plugin.'];
    }
    if ($ttydExec === null) {
        return [false, "Unraid's terminal helper (ttyd-exec) was not found on this server, so a console cannot be started."];
    }
    $lock = @fopen(sys_get_temp_dir() . '/app.tabs.console.' . md5($sock) . '.lock', 'c');
    if ($lock !== false) {
        @flock($lock, LOCK_EX);
    }
    try {
        $good = [];
        foreach (apptabs_ttyd_procs($sock) as $p) {
            if ($p['tail'] === $want && $good === []) {
                $good = $p;
            } else {
                apptabs_kill_pid($p['pid']);   // a different command (tab edited), or a duplicate
            }
        }
        if ($good !== []) {
            if (apptabs_wait_alive($sock, 3.0)) {
                return [true, ''];
            }
            apptabs_kill_pid($good['pid']);    // up but not accepting: replace it
        }
        apptabs_drop_stale_socket($sock);
        // -s1: on disconnect ttyd sends SIGHUP (not SIGKILL) to the wrapper, so it can end the container-side process.
        [$rc] = apptabs_run(array_merge([$ttydExec, '-s1', '-i', $sock], $want), 8.0);
        if ($rc !== 0) {
            return [false, 'The terminal helper (ttyd-exec) failed to start.'];
        }
        if (!apptabs_wait_alive($sock, 3.0)) {
            return [false, 'The terminal server did not start within 3 seconds. Reload the page to try again.'];
        }
        return [true, ''];
    } finally {
        if ($lock !== false) {
            @flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}

/**
 * Everything a console page needs before it may show an iframe: the container exists and is running, the tmux session
 * exists (when one is configured), and a ttyd is serving the tab's socket.
 * @return array{0: bool, 1: string, 2: string} ok, message when not ok, iframe URL
 */
function apptabs_console_prepare(string $slug, array $tab): array
{
    $c = (string) ($tab['container'] ?? '');
    $s = (string) ($tab['session'] ?? '');
    if (apptabs_validate_container($c) !== null || apptabs_validate_session($s) !== null) {
        return [false, 'This console tab has an invalid container or session name. Fix it in Settings, Utilities, App Tabs.', ''];
    }
    [$state, $err] = apptabs_container_state($c);
    if ($state === null) {
        return [false, (string) $err, ''];
    }
    if ($state === 'missing') {
        return [false, "There is no Docker container named $c. Check the name in Settings, Utilities, App Tabs.", ''];
    }
    if ($state !== 'running') {
        return [false, "The container $c is not running (it is $state). Start it from the Docker tab, then reload this page.", ''];
    }
    if ($s !== '') {
        $docker = (string) apptabs_find_bin('docker', 'APPTABS_DOCKER');
        [$rc, , $e] = apptabs_run([$docker, 'exec', $c, 'tmux', 'has-session', '-t', '=' . $s], 8.0);
        if ($rc !== 0) {
            $missingTmux = $rc === 126 || $rc === 127 || stripos($e, 'executable file not found') !== false;
            return [false, $missingTmux
                ? "tmux is not installed in the container $c, so the session $s cannot be shown. Clear the session name in the tab's settings to open a shell instead."
                : "The container $c has no tmux session named $s (or tmux is not running there). Start it, then reload this page.", ''];
        }
    }
    [$ok, $msg] = apptabs_console_ensure_ttyd($slug, $tab);
    return $ok ? [true, '', apptabs_console_url($slug)] : [false, $msg, ''];
}

/**
 * Stop the console ttyds that no tab wants any more, or whose command no longer matches the tab (container or session
 * edited, tab disabled or deleted). Called after a save and when the plugin is removed; never starts anything.
 * @param list<array> $list normalised tab list ([] stops them all)
 */
function apptabs_console_reap(array $list): int
{
    $wanted = [];
    $docker = apptabs_find_bin('docker', 'APPTABS_DOCKER');
    foreach ($list as $t) {
        if ($t['kind'] === 'console' && $t['enabled'] && $docker !== null) {
            try {
                $wanted[apptabs_console_sockpath(apptabs_slug($t['label']))] = apptabs_console_command($t, $docker);
            } catch (\Throwable $e) {
                // an unusable tab wants nothing running
            }
        }
    }
    $stopped = 0;
    foreach (apptabs_ttyd_procs() as $p) {
        if (dirname($p['sock']) !== apptabs_sock_dir()) {
            continue;
        }
        if (!isset($wanted[$p['sock']]) || $wanted[$p['sock']] !== $p['tail']) {
            apptabs_kill_pid($p['pid']);
            apptabs_drop_stale_socket($p['sock']);
            $stopped++;
        }
    }
    return $stopped;
}
