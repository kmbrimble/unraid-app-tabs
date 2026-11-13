<?php
/**
 * Regenerate the top-bar tab pages from /boot/config/plugins/app.tabs/tabs.json. Run by the .plg install block (so it
 * happens on install, upgrade and every boot). A config that does not load is reported and generates no tabs; it is
 * never fatal to the install.
 */

declare(strict_types=1);

require_once __DIR__ . '/tabs.php';

// CLI-only guard: printing and the exit code live here, never in tabs.php (which also runs under php-fpm).
if (PHP_SAPI === 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    [$ok, $msg] = apptabs_generate();
    echo 'app.tabs: ' . ($ok ? '' : 'WARNING: ') . $msg . "\n";
    exit($ok ? 0 : 1);
}
